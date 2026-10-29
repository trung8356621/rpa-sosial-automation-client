import type { WebContents } from "electron";
import type { SessionSignal } from "../../shared/contracts.js";
import { logClientEvent } from "../main-error-log.js";
import { AuthScriptLoader } from "./auth-script-loader.js";
import { AuthScriptResolver } from "./auth-script-resolver.js";
import type { AuthRunOutcome, AuthScriptRunner } from "./auth-script-runner.js";
import type { AccountCredentialSource } from "./credential-mapper.js";
import { hasExplicitTagContext, type AuthReleasePulled, type AuthTagContext } from "./auth-script-types.js";
import type { AuthPipelineResult } from "./outcomes.js";

export type AuthRunnerLike = Pick<AuthScriptRunner, "run"> | {
  run: (params: {
    webContents: WebContents;
    release: AuthReleasePulled;
    account: AccountCredentialSource;
    timeoutMs?: number;
  }) => Promise<AuthRunOutcome>;
};

export type BrowserOpenAuthDeps = {
  resolver: AuthScriptResolver;
  loader: AuthScriptLoader;
  runner: AuthRunnerLike;
};

/**
 * Auth Script before existing Checkpoint (session signal).
 * Browser Open WITHOUT Action Tag context skips Auth entirely.
 */
export class BrowserOpenOrchestrator {
  private readonly inFlight = new Map<string, Promise<AuthPipelineResult>>();

  constructor(private readonly deps: BrowserOpenAuthDeps) {}

  async runAfterBrowserOpen(params: {
    browserId: string;
    accountId: string;
    partition: string;
    tag?: AuthTagContext | null;
    webContents: WebContents | null | undefined;
    account: AccountCredentialSource;
    runCheckpoint: () => Promise<SessionSignal>;
  }): Promise<AuthPipelineResult> {
    const existing = this.inFlight.get(params.browserId);
    if (existing) {
      logClientEvent("Auth pipeline already in flight — reusing (no duplicate)", {
        browserId: params.browserId,
      });
      return existing;
    }

    const work = this.execute(params).finally(() => {
      this.inFlight.delete(params.browserId);
    });
    this.inFlight.set(params.browserId, work);
    return work;
  }

  /** Test/helper: whether a browser currently has Auth in flight. */
  isAuthInFlight(browserId: string): boolean {
    return this.inFlight.has(browserId);
  }

  private async execute(params: {
    browserId: string;
    accountId: string;
    partition: string;
    tag?: AuthTagContext | null;
    webContents: WebContents | null | undefined;
    account: AccountCredentialSource;
    runCheckpoint: () => Promise<SessionSignal>;
  }): Promise<AuthPipelineResult> {
    const { browserId, accountId, partition, tag, webContents, account, runCheckpoint } = params;

    if (!hasExplicitTagContext(tag)) {
      const signal = await runCheckpoint();
      return checkpointResult("NO_TAG_CONTEXT", "skipped", signal, {
        message: "Không có Action Tag context — bỏ qua Auth Script (manual login).",
      });
    }

    logClientEvent("Auth pipeline resolve", {
      browserId,
      accountId,
      partition,
      actionTagId: tag?.actionTagId,
      actionTagKey: tag?.actionTagKey,
    });

    const resolved = await this.deps.resolver.resolve(accountId, tag!);
    if (resolved.kind === "no_tag_context") {
      const signal = await runCheckpoint();
      return checkpointResult("NO_TAG_CONTEXT", "skipped", signal, {
        message: "Không có Action Tag context — bỏ qua Auth Script.",
      });
    }
    if (resolved.kind === "no_auth_configured") {
      const signal = await runCheckpoint();
      return checkpointResult("NO_AUTH_CONFIGURED", "resolve", signal, {
        message: "Action Tag chưa gắn Auth pin — manual login.",
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        serverError: resolved.serverError,
      });
    }
    if (resolved.kind === "error") {
      // Keep browser open; still run Checkpoint (manual login remains).
      const signal = await runCheckpoint();
      return {
        code: resolved.code,
        phase: "resolve",
        authExecutionOk: false,
        checkpointStatus: signal.status,
        message: resolved.message,
        serverError: resolved.serverError,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
      };
    }

    const expected = resolved.release;
    const loaded = await this.deps.loader.pullExact(accountId, tag!, expected);
    if (loaded.kind === "error") {
      const signal = await runCheckpoint();
      return {
        code: loaded.code,
        phase: "pull",
        authExecutionOk: false,
        checkpointStatus: signal.status,
        message: loaded.message,
        serverError: loaded.serverError,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
      };
    }

    if (!webContents || webContents.isDestroyed()) {
      const signal = await runCheckpoint();
      return {
        code: "AUTH_EXECUTION_FAILED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: signal.status,
        message: "WebContents không sẵn sàng — không thể chạy Auth trong partition.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
      };
    }

    const run = await this.deps.runner.run({
      webContents,
      release: loaded.release,
      account,
    });

    // Checkpoint ALWAYS runs after Auth attempt — Auth OK ≠ login success.
    const signal = await runCheckpoint();

    if (run.kind === "timeout") {
      return {
        code: "AUTH_TIMEOUT",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: signal.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
      };
    }

    if (run.kind === "error") {
      return {
        code: "AUTH_EXECUTION_FAILED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: signal.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
      };
    }

    if (signal.status === "present") {
      return {
        code: "CHECKPOINT_PASSED",
        phase: "checkpoint",
        authExecutionOk: true,
        checkpointStatus: "present",
        message: "Auth Script chạy xong; Checkpoint (session signal) PRESENT.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
      };
    }

    if (signal.status === "absent" || signal.status === "unsupported" || signal.status === "error") {
      return {
        code: "CHECKPOINT_FAILED",
        phase: "checkpoint",
        authExecutionOk: true,
        checkpointStatus: signal.status,
        message: "Auth Script chạy xong nhưng Checkpoint chưa xác nhận login.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
      };
    }

    return {
      code: "UNKNOWN",
      phase: "checkpoint",
      authExecutionOk: true,
      checkpointStatus: signal.status,
      message: "Kết quả Checkpoint không chắc chắn.",
      packageKey: expected.package_key,
      releaseId: expected.release_id,
      version: expected.version,
      contentDigest: expected.content_digest,
    };
  }
}

function checkpointResult(
  code: AuthPipelineResult["code"],
  phase: AuthPipelineResult["phase"],
  signal: SessionSignal,
  extra: Partial<AuthPipelineResult> & { message: string }
): AuthPipelineResult {
  return {
    code,
    phase,
    authExecutionOk: false,
    checkpointStatus: signal.status,
    ...extra,
  };
}
