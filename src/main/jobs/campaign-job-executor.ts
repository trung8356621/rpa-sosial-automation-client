import type { WebContents } from "electron";
import type { AuthReleasePulled, AuthScriptVariable } from "../auth/auth-script-types.js";
import { AuthScriptRunner, type AuthRunOutcome } from "../auth/auth-script-runner.js";
import type { AccountCredentialSource } from "../auth/credential-mapper.js";
import type { AuthAssetDownloader } from "../orc/asset-store.js";
import type { Rect } from "../orc/contracts.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import { CampaignJobApi } from "./campaign-job-api.js";
import { CampaignScriptLoader } from "./campaign-script-loader.js";
import {
  resolveClaimScriptPin,
  type CampaignJobClaim,
  type CampaignJobResultStatus,
} from "./contracts.js";
import { JobAttemptIdempotencyStore } from "./idempotency.js";
import { requireTitleBinding, resolveJobVariableBindings } from "./job-input-bindings.js";
import { verifyWordPressDraft } from "./wordpress-draft-verify.js";

export type CampaignJobBrowserHost = {
  open(browserId: string): Promise<void>;
  getWebContents(): WebContents | undefined;
  getBounds(): Rect;
  applyViewport(size: { width: number; height: number }): void | Promise<void>;
  restoreViewport(): void | Promise<void>;
  lock(params: { reason?: string; message?: string; onStop?: () => void }): Promise<void>;
  release(reason?: string): Promise<void>;
  findProfileForJob(claim: CampaignJobClaim): {
    ok: true;
    browserId: string;
    accountId: string;
    partition: string;
  } | { ok: false; message: string };
  loadAccount(accountId: string): Promise<AccountCredentialSource>;
};

export type CampaignJobExecuteOutcome = {
  reported: boolean;
  status: CampaignJobResultStatus;
  code: string;
  message: string;
  stepsExecuted: number;
  draftVerified?: boolean;
  idempotentSkip?: boolean;
};

const DEFAULT_JOB_TIMEOUT_MS = 180_000;
const PROGRESS_INTERVAL_MS = 20_000;

export class CampaignJobExecutor {
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly api: CampaignJobApi,
    private readonly scriptLoader: CampaignScriptLoader,
    private readonly host: CampaignJobBrowserHost,
    private readonly runner: AuthScriptRunner = new AuthScriptRunner(),
    private readonly idempotency: JobAttemptIdempotencyStore = new JobAttemptIdempotencyStore(),
    private readonly downloadAsset?: AuthAssetDownloader
  ) {}

  getIdempotencyStore(): JobAttemptIdempotencyStore {
    return this.idempotency;
  }

  cancelActive(reason = "user_stop"): void {
    this.activeAbort?.abort(reason);
  }

  async execute(claim: CampaignJobClaim, opts?: { timeoutMs?: number }): Promise<CampaignJobExecuteOutcome> {
    if (this.idempotency.hasTerminal(claim.job_id, claim.attempt_id)) {
      const prev = this.idempotency.get(claim.job_id, claim.attempt_id);
      logClientEvent("CAMPAIGN_JOB_IDEMPOTENT_SKIP", {
        jobId: claim.job_id,
        attemptId: claim.attempt_id,
        previous: prev?.status,
      });
      return {
        reported: false,
        status: (prev?.status as CampaignJobResultStatus) || "unknown",
        code: "IDEMPOTENT_SKIP",
        message: "Same job attempt already terminal — không thực thi lại.",
        stepsExecuted: 0,
        idempotentSkip: true,
      };
    }

    if (!isLeaseValid(claim.lease_expires_at)) {
      return this.failLocal(claim, "LEASE_EXPIRED", "Lease đã hết hạn trước execute.");
    }

    const profile = this.host.findProfileForJob(claim);
    if (!profile.ok) {
      return this.reportTerminal(claim, "failed", "ACCOUNT_BROWSER_MISMATCH", profile.message, {
        stepsExecuted: 0,
      });
    }

    if (!resolveClaimScriptPin(claim)) {
      logClientEvent("CAMPAIGN_JOB_CONTRACT_GAP", {
        jobId: claim.job_id,
        code: "CONTRACT_GAP_CLAIM_PIN",
        message: "Claim thiếu release_id/content_digest/execution_digest — không ACK.",
      });
      return {
        reported: false,
        status: "failed",
        code: "CONTRACT_GAP_CLAIM_PIN",
        message: "Claim thiếu exact script pin (release_id + content_digest + execution_digest).",
        stepsExecuted: 0,
      };
    }

    const pull = await this.scriptLoader.pullPinned(claim);
    if (pull.kind === "contract_gap") {
      // Do not ACK / do not report failed_locked for Addon contract gaps.
      logClientEvent("CAMPAIGN_JOB_CONTRACT_GAP", {
        jobId: claim.job_id,
        code: pull.gap.code,
        missing: pull.gap.missing,
        message: pull.gap.message,
      });
      return {
        reported: false,
        status: "failed",
        code: pull.gap.code,
        message: pull.gap.message,
        stepsExecuted: 0,
      };
    }
    if (pull.kind === "error") {
      return this.reportTerminal(claim, "failed", pull.code, pull.message, { stepsExecuted: 0 });
    }

    const ack = await this.api.ack(claim.job_id, {
      attempt_id: claim.attempt_id,
      lease_token: claim.lease_token,
    });
    if (!ack.ok) {
      const stale = ack.errors.some((e) => /stale|fence/i.test(e));
      return {
        reported: false,
        status: "failed",
        code: stale ? "STALE_LEASE" : "ACK_FAILED",
        message: ack.message,
        stepsExecuted: 0,
      };
    }

    const abort = new AbortController();
    this.activeAbort = abort;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let stepsExecuted = 0;
    const downloadAsset =
      this.downloadAsset ?? this.scriptLoader.createAssetDownloader(claim);

    try {
      await this.host.open(profile.browserId);
      const webContents = this.host.getWebContents();
      if (!webContents || webContents.isDestroyed()) {
        return await this.reportTerminal(
          claim,
          "failed",
          "BROWSER_UNAVAILABLE",
          "Không mở được WebContents cho Account/Browser partition.",
          { stepsExecuted: 0 }
        );
      }

      const account = await this.host.loadAccount(profile.accountId);
      const variables = Array.isArray(pull.release.manifest.variables)
        ? (pull.release.manifest.variables as AuthScriptVariable[])
        : [];
      const bindings = await resolveJobVariableBindings({
        variables,
        jobInput: claim.input,
        account,
      });
      if (!bindings.ok) {
        return await this.reportTerminal(claim, "failed", "INPUT_BINDING_FAILED", bindings.message, {
          stepsExecuted: 0,
        });
      }
      const titleCheck = requireTitleBinding(bindings.values, variables);
      if (!titleCheck.ok) {
        return await this.reportTerminal(claim, "failed", "INPUT_BINDING_FAILED", titleCheck.message, {
          stepsExecuted: 0,
        });
      }

      await this.host.lock({
        reason: "campaign_job",
        message: "Campaign Job đang chạy — Vui lòng không thao tác",
        onStop: () => abort.abort("user_stop"),
      });

      progressTimer = setInterval(() => {
        void this.api.progress(claim.job_id, {
          attempt_id: claim.attempt_id,
          lease_token: claim.lease_token,
          message: "executing",
          step: `steps=${stepsExecuted}`,
        });
      }, PROGRESS_INTERVAL_MS);

      logClientEvent("CAMPAIGN_JOB_EXECUTE_START", {
        jobId: claim.job_id,
        attemptId: claim.attempt_id,
        accountId: claim.account_id,
        browserId: claim.browser_id,
        scriptId: claim.script_id,
        scriptVersion: claim.script_version,
        releaseId: pull.pinned.release_id,
        contentDigest: pull.pinned.content_digest,
        executionDigest: pull.pinned.execution_digest,
        runMode: claim.run_mode,
      });

      const run = await this.runner.run({
        webContents,
        release: pull.release,
        account,
        accountId: profile.accountId,
        timeoutMs,
        signal: abort.signal,
        viewBounds: this.host.getBounds(),
        applyViewport: (size) => this.host.applyViewport(size),
        restoreViewport: () => this.host.restoreViewport(),
        downloadAsset,
        inputValues: bindings.values,
      });

      stepsExecuted = run.stepsExecuted;
      const mapped = mapRunOutcome(run);
      if (mapped.status !== "succeeded") {
        return await this.reportTerminal(claim, mapped.status, mapped.code, mapped.message, {
          stepsExecuted,
        });
      }

      // Never report WordPress draft success without live verification.
      const draft = await verifyWordPressDraft({
        webContents,
        title: titleCheck.title || bindings.values.title || "",
      });
      if (!draft.verified) {
        return await this.reportTerminal(
          claim,
          "failed",
          "DRAFT_NOT_VERIFIED",
          `ORC xong nhưng WordPress draft chưa xác minh: ${draft.evidence}`,
          {
            stepsExecuted,
            output: { draft },
          }
        );
      }

      return await this.reportTerminal(claim, "succeeded", "OK", "WordPress draft verified.", {
        stepsExecuted,
        output: {
          draft,
          script_id: claim.script_id,
          script_version: claim.script_version,
          release_id: pull.pinned.release_id,
          content_digest: pull.pinned.content_digest,
          execution_digest: pull.pinned.execution_digest,
        },
        draftVerified: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = abort.signal.aborted || /abort|cancel/i.test(message);
      return await this.reportTerminal(
        claim,
        cancelled ? "cancelled" : "failed",
        cancelled ? "CANCELLED" : "EXECUTE_ERROR",
        message,
        { stepsExecuted }
      );
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      try {
        await this.host.release("campaign_job_end");
      } catch {
        /* ignore */
      }
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private failLocal(
    claim: CampaignJobClaim,
    code: string,
    message: string
  ): CampaignJobExecuteOutcome {
    return {
      reported: false,
      status: "failed",
      code,
      message,
      stepsExecuted: 0,
    };
  }

  private async reportTerminal(
    claim: CampaignJobClaim,
    status: CampaignJobResultStatus,
    code: string,
    message: string,
    extra: {
      stepsExecuted: number;
      output?: Record<string, unknown>;
      draftVerified?: boolean;
    }
  ): Promise<CampaignJobExecuteOutcome> {
    const body = {
      attempt_id: claim.attempt_id,
      lease_token: claim.lease_token,
      status,
      output: {
        code,
        steps_executed: extra.stepsExecuted,
        ...(extra.output || {}),
      },
      error:
        status === "succeeded"
          ? null
          : {
              code,
              message: message.slice(0, 2000),
            },
    };
    const res = await this.api.result(claim.job_id, body);
    if (res.ok) {
      this.idempotency.markTerminal(claim.job_id, claim.attempt_id, status);
    } else {
      logClientError("CAMPAIGN_JOB_RESULT_REPORT_FAILED", {
        jobId: claim.job_id,
        attemptId: claim.attempt_id,
        status,
        errors: res.errors,
        message: res.message,
      });
    }
    logClientEvent("CAMPAIGN_JOB_TERMINAL", {
      jobId: claim.job_id,
      attemptId: claim.attempt_id,
      status,
      code,
      reported: res.ok,
      idempotent: res.ok ? res.idempotent : false,
      stepsExecuted: extra.stepsExecuted,
      draftVerified: extra.draftVerified ?? false,
    });
    return {
      reported: res.ok,
      status,
      code,
      message,
      stepsExecuted: extra.stepsExecuted,
      draftVerified: extra.draftVerified,
    };
  }
}

function isLeaseValid(expiresAt: string): boolean {
  if (!expiresAt) return true; // if Addon omits, rely on fence tokens
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return true;
  return t > Date.now() + 1_000;
}

function mapRunOutcome(run: AuthRunOutcome): {
  status: CampaignJobResultStatus;
  code: string;
  message: string;
} {
  switch (run.kind) {
    case "ok":
      return { status: "succeeded", code: "ORC_OK", message: "ORC completed" };
    case "cancelled":
      return { status: "cancelled", code: "CANCELLED", message: run.message };
    case "timeout":
      return { status: "failed", code: "TIMEOUT", message: run.message };
    case "human_required":
      return { status: "unknown", code: "HUMAN_REQUIRED", message: run.message };
    case "asset_unavailable":
      return { status: "failed", code: run.code, message: run.message };
    case "orc_unavailable":
      return { status: "failed", code: "ORC_UNAVAILABLE", message: run.message };
    case "viewport_mismatch":
      return { status: "failed", code: "VIEWPORT_MISMATCH", message: run.message };
    case "error":
    default:
      return { status: "failed", code: "ORC_ERROR", message: run.message };
  }
}

/** Exported for tests — ensure unused import of AuthReleasePulled stays typed. */
export type { AuthReleasePulled };
