import type { WebContents } from "electron";
import { validateAuthNavigationTarget } from "../auth/auth-navigation.js";
import type { AuthReleasePulled, AuthScriptVariable } from "../auth/auth-script-types.js";
import { AuthScriptRunner, type AuthRunOutcome } from "../auth/auth-script-runner.js";
import type { AccountCredentialSource } from "../auth/credential-mapper.js";
import type { ExecutionViewportVerification } from "../browser/embedded-browser.js";
import type { AuthAssetDownloader } from "../orc/asset-store.js";
import type { Rect } from "../orc/contracts.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import { CampaignJobApi } from "./campaign-job-api.js";
import { CampaignScriptLoader } from "./campaign-script-loader.js";
import {
  doesSiteKeyMatchSiteUrl,
  resolveClaimScriptPin,
  type CampaignJobClaim,
  type CampaignJobResultRequest,
  type CampaignJobResultStatus,
} from "./contracts.js";
import type { FailureScreenshotArtifact } from "./failure-screenshot.js";
import { JobAttemptIdempotencyStore } from "./idempotency.js";
import { requireTitleBinding, resolveJobVariableBindings } from "./job-input-bindings.js";
import { verifyWordPressDraft } from "./wordpress-draft-verify.js";

export type CampaignJobBrowserHost = {
  prepareForExecution?: (browserId: string) => void | Promise<void>;
  verifyExecutionViewport?: () => Promise<ExecutionViewportVerification | null>;
  captureFailureScreenshot?: (params: {
    jobId: string;
    attemptId: string;
    code: string;
  }) => Promise<FailureScreenshotArtifact | null>;
  open(browserId: string): Promise<void>;
  navigate?: (url: string) => Promise<void>;
  getWebContents(): WebContents | undefined;
  getAuthState?: () => { code: string; checkpointStatus?: string; message: string } | null;
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

const BLOCKING_AUTH_FAILURE_CODES = new Set([
  "AUTH_EXECUTION_FAILED",
  "AUTH_TIMEOUT",
  "AUTH_INTEGRITY_FAILED",
  "AUTH_DOWNLOAD_FAILED",
  "ORC_RUNTIME_UNAVAILABLE",
  "ASSET_DOWNLOAD_UNAVAILABLE",
  "ASSET_INTEGRITY_FAILED",
  "VIEWPORT_MISMATCH",
  "NO_ACCOUNT_TAG_ENTITLEMENT",
  "CLIENT_LEASE_INVALID",
  "AUTH_CONTEXT_AMBIGUOUS",
  "AUTH_CONTEXT_UNAVAILABLE",
  "AUTH_CANCELLED",
  "CHECKPOINT_FAILED",
  "SESSION_UNKNOWN",
  "NO_TAG_CONTEXT",
]);

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
      let reported = false;
      if (
        prev?.state === "terminal_pending_delivery" &&
        !prev.deliveryStopped &&
        prev.pendingPayload &&
        (!prev.nextRetryAt || Date.now() >= prev.nextRetryAt)
      ) {
        const delivery = await this.deliverPendingResult(
          claim.job_id,
          claim.attempt_id,
          claim.lease_token
        );
        reported = delivery.ok;
      }
      logClientEvent("CAMPAIGN_JOB_IDEMPOTENT_SKIP", {
        jobId: claim.job_id,
        attemptId: claim.attempt_id,
        previousState: prev?.state ?? null,
        previousStatus: prev?.status ?? null,
        redeliveryAttempted: prev?.state === "terminal_pending_delivery",
        reported,
      });
      return {
        reported,
        status: (prev?.status as CampaignJobResultStatus) || "unknown",
        code: "IDEMPOTENT_SKIP",
        message: "Same job attempt already executed — không thực thi lại.",
        stepsExecuted: Number(prev?.pendingPayload?.output?.steps_executed ?? 0) || 0,
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

    this.idempotency.markExecuting(claim.job_id, claim.attempt_id);

    const abort = new AbortController();
    this.activeAbort = abort;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let stepsExecuted = 0;
    const downloadAsset =
      this.downloadAsset ?? this.scriptLoader.createAssetDownloader(claim);

    try {
      await this.host.prepareForExecution?.(profile.browserId);
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

      const authState = this.host.getAuthState?.();
      if (authState) {
        if (authState.code === "HUMAN_REQUIRED") {
          return await this.reportTerminal(
            claim,
            "unknown",
            "HUMAN_REQUIRED",
            authState.message || "Auth yêu cầu xác minh thủ công.",
            { stepsExecuted: 0 }
          );
        }
        if (BLOCKING_AUTH_FAILURE_CODES.has(authState.code)) {
          return await this.reportTerminal(
            claim,
            "failed",
            authState.code,
            authState.message || `Auth/Session chưa sẵn sàng (${authState.code}).`,
            { stepsExecuted: 0 }
          );
        }
      }

      const account = await this.host.loadAccount(profile.accountId);
      if (claim.site_key && account.siteUrl && !doesSiteKeyMatchSiteUrl(claim.site_key, account.siteUrl)) {
        return await this.reportTerminal(
          claim,
          "failed",
          "SITE_MISMATCH",
          `Site mismatch: claim site_key=${claim.site_key} ≠ account siteUrl=${account.siteUrl}`,
          { stepsExecuted: 0 }
        );
      }
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

      const entryContext = pull.executionContext ?? claim.execution_context;
      const resolvedEntryUrl = entryContext?.resolvedUrl?.trim() || "";
      const hasNavigateStep =
        Array.isArray(pull.release.manifest.steps) &&
        pull.release.manifest.steps.some((s) => {
          const action = String((s as Record<string, unknown>)?.action || "").trim().toLowerCase();
          return action === "navigate" || action === "goto" || action === "open_url";
        });

      if (resolvedEntryUrl) {
        const validated = validateAuthNavigationTarget({
          targetUrl: resolvedEntryUrl,
          authorizedSiteUrl: account.siteUrl,
        });
        if (!validated.ok) {
          return await this.reportTerminal(
            claim,
            "failed",
            "ACTION_NAVIGATION_FAILED",
            validated.reason,
            { stepsExecuted: 0 }
          );
        }
        if (!this.host.navigate) {
          return await this.reportTerminal(
            claim,
            "failed",
            "ACTION_NAVIGATION_FAILED",
            "Host không hỗ trợ navigate tới Action entry URL.",
            { stepsExecuted: 0 }
          );
        }
        logClientEvent("CAMPAIGN_JOB_NAVIGATE", {
          jobId: claim.job_id,
          attemptId: claim.attempt_id,
          targetUrl: validated.url,
          actionTagKey: claim.action_tag_key ?? null,
          source: entryContext?.source ?? null,
        });
        try {
          await this.host.navigate(validated.url);
        } catch (navErr) {
          const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
          return await this.reportTerminal(
            claim,
            "failed",
            "ACTION_NAVIGATION_FAILED",
            `Không điều hướng được tới Action entry URL (${validated.url}): ${navMsg}`,
            { stepsExecuted: 0 }
          );
        }
      } else if (!hasNavigateStep && (Boolean(entryContext) || Boolean(this.host.navigate))) {
        return await this.reportTerminal(
          claim,
          "failed",
          "ACTION_ENTRY_URL_MISSING",
          "Thiếu execution_context.resolved_url cho Action Script không có bước navigate.",
          { stepsExecuted: 0 }
        );
      }

      await this.host.lock({
        reason: "campaign_job",
        message: "Campaign Job đang chạy — Vui lòng không thao tác",
        onStop: () => abort.abort("user_stop"),
      });

      const viewportVerification = await this.host.verifyExecutionViewport?.();

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
        viewport: viewportVerification ?? null,
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
    let screenshotArtifact: FailureScreenshotArtifact | null = null;
    if (status !== "succeeded" && this.host.captureFailureScreenshot) {
      try {
        screenshotArtifact = await this.host.captureFailureScreenshot({
          jobId: claim.job_id,
          attemptId: claim.attempt_id,
          code,
        });
      } catch (err) {
        screenshotArtifact = {
          status: "capture_failed",
          kind: "failure_screenshot",
          job_id: claim.job_id,
          attempt_id: claim.attempt_id,
          error_code: code,
          mime_type: "image/png",
          sha256: null,
          size_bytes: null,
          width: null,
          height: null,
          local_path: null,
          url: "",
          redacted: false,
          captured_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : String(err),
        };
      }
      if (screenshotArtifact) {
        logClientEvent("CAMPAIGN_JOB_FAILURE_SCREENSHOT", {
          jobId: claim.job_id,
          attemptId: claim.attempt_id,
          errorCode: code,
          captureStatus: screenshotArtifact.status,
          redacted: screenshotArtifact.redacted,
          sha256: screenshotArtifact.sha256,
          localPath: screenshotArtifact.local_path,
          errorMessage: screenshotArtifact.error_message ?? null,
        });
      }
    }

    const body: CampaignJobResultRequest = {
      attempt_id: claim.attempt_id,
      lease_token: claim.lease_token,
      status,
      output: {
        code,
        steps_executed: extra.stepsExecuted,
        ...(extra.output || {}),
        ...(screenshotArtifact ? { screenshot_artifact: screenshotArtifact } : {}),
      },
      error:
        status === "succeeded"
          ? null
          : {
              code,
              message: message.slice(0, 2000),
            },
      ...(screenshotArtifact
        ? {
            artifacts: [
              {
                ...screenshotArtifact,
                binary_upload_supported: false,
                upload_note:
                  "Backend /client/jobs/{jobId}/result accepts artifact metadata only; no binary screenshot upload endpoint exists.",
              },
            ],
          }
        : {}),
    };

    // Persist terminal outcome and original payload BEFORE attempting network delivery.
    this.idempotency.markTerminalPending(claim.job_id, claim.attempt_id, {
      status,
      code,
      message,
      payload: body,
      localScreenshotArtifact: screenshotArtifact,
    });

    const delivery = await this.deliverPendingResult(claim.job_id, claim.attempt_id);
    logClientEvent("CAMPAIGN_JOB_TERMINAL", {
      jobId: claim.job_id,
      attemptId: claim.attempt_id,
      status,
      code,
      reported: delivery.ok,
      idempotent: delivery.idempotent,
      usedFallbackWithoutArtifacts: delivery.usedFallback,
      stepsExecuted: extra.stepsExecuted,
      draftVerified: extra.draftVerified ?? false,
      screenshotCaptureStatus: screenshotArtifact?.status ?? null,
      screenshotUploadStatus: screenshotArtifact
        ? delivery.ok
          ? delivery.usedFallback
            ? "retained_local_only"
            : "metadata_reported"
          : "failed"
        : null,
    });
    return {
      reported: delivery.ok,
      status,
      code,
      message,
      stepsExecuted: extra.stepsExecuted,
      draftVerified: extra.draftVerified,
    };
  }

  async flushPendingResults(): Promise<number> {
    const pending = this.idempotency.listPendingDelivery();
    let delivered = 0;
    for (const rec of pending) {
      const res = await this.deliverPendingResult(rec.jobId, rec.attemptId);
      if (res.ok) delivered += 1;
    }
    return delivered;
  }

  private async deliverPendingResult(
    jobId: string,
    attemptId: string,
    overrideLeaseToken?: string
  ): Promise<{ ok: boolean; idempotent: boolean; usedFallback: boolean }> {
    const rec = this.idempotency.get(jobId, attemptId);
    if (!rec?.pendingPayload) {
      return { ok: false, idempotent: false, usedFallback: false };
    }
    const payload: CampaignJobResultRequest = overrideLeaseToken
      ? { ...rec.pendingPayload, lease_token: overrideLeaseToken }
      : rec.pendingPayload;

    const res = await this.api.result(jobId, payload);
    if (res.ok) {
      this.idempotency.markTerminalAcknowledged(jobId, attemptId, { lastDeliveryStatus: 200 });
      return { ok: true, idempotent: Boolean(res.idempotent), usedFallback: false };
    }

    const isAuthOrFenceError =
      res.status === 401 ||
      res.status === 403 ||
      res.errors.some((e) => /stale|fence|expired/i.test(e));

    // Compatibility fallback: if Backend rejects artifacts[] validation, retry with original result without artifacts[].
    let finalRes = res;
    let payloadWithoutArtifacts: CampaignJobResultRequest | undefined;
    if (!isAuthOrFenceError && (res.status === 422 || res.status === 400) && payload.artifacts?.length) {
      logClientEvent("CAMPAIGN_JOB_RESULT_ARTIFACTS_REJECTED", {
        jobId,
        attemptId,
        httpStatus: res.status,
        errors: res.errors,
        message: res.message,
      });
      const cleanOutput = payload.output ? { ...payload.output } : undefined;
      if (cleanOutput && "screenshot_artifact" in cleanOutput) {
        delete cleanOutput.screenshot_artifact;
      }
      payloadWithoutArtifacts = {
        attempt_id: payload.attempt_id,
        lease_token: payload.lease_token,
        status: payload.status,
        ...(cleanOutput ? { output: cleanOutput } : {}),
        error: payload.error,
      };
      const fallbackRes = await this.api.result(jobId, payloadWithoutArtifacts);
      if (fallbackRes.ok) {
        this.idempotency.markTerminalAcknowledged(jobId, attemptId, { lastDeliveryStatus: 200 });
        logClientEvent("CAMPAIGN_JOB_RESULT_DELIVERED_WITHOUT_ARTIFACTS", {
          jobId,
          attemptId,
          status: payload.status,
          code: rec.code,
          localScreenshotPath: rec.localScreenshotArtifact?.local_path ?? null,
        });
        return { ok: true, idempotent: Boolean(fallbackRes.idempotent), usedFallback: true };
      }
      finalRes = fallbackRes;
    }

    const nextAttempts = rec.deliveryAttempts + 1;
    const isPermanent =
      isAuthOrFenceError ||
      finalRes.status === 404 ||
      finalRes.status === 409 ||
      finalRes.status === 422 ||
      finalRes.status === 400 ||
      nextAttempts >= 10;

    const backoffMs = Math.min(300_000, 15_000 * 2 ** Math.min(6, rec.deliveryAttempts));
    this.idempotency.recordDeliveryFailure(jobId, attemptId, {
      status: finalRes.status,
      errors: finalRes.errors,
      message: finalRes.message,
      permanent: isPermanent,
      nextRetryAt: isPermanent ? undefined : Date.now() + backoffMs,
      payloadWithoutArtifacts,
    });

    logClientError("CAMPAIGN_JOB_RESULT_REPORT_FAILED", {
      jobId,
      attemptId,
      status: rec.status,
      code: rec.code,
      httpStatus: finalRes.status,
      errors: finalRes.errors,
      message: finalRes.message,
      permanent: isPermanent,
      deliveryAttempts: nextAttempts,
      screenshotCaptureStatus: rec.localScreenshotArtifact?.status ?? null,
      screenshotUploadStatus: rec.localScreenshotArtifact ? "failed" : null,
    });

    return { ok: false, idempotent: false, usedFallback: false };
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
