import type { WebContents } from "electron";
import type { SessionSignal } from "../../shared/contracts.js";
import { logClientEvent } from "../main-error-log.js";
import { AuthScriptLoader } from "./auth-script-loader.js";
import { AuthScriptResolver } from "./auth-script-resolver.js";
import type { AuthRunOutcome } from "./auth-script-runner.js";
import type { AccountCredentialSource } from "./credential-mapper.js";
import { hasExplicitTagContext, type AuthReleasePulled, type AuthTagContext } from "./auth-script-types.js";
import type { AuthPipelineResult } from "./outcomes.js";
import type { AuthAssetDownloader } from "../orc/asset-store.js";
import { isAtAuthTarget, validateAuthNavigationTarget } from "./auth-navigation.js";

export type AuthRunnerLike = {
  run: (params: {
    webContents: WebContents;
    release: AuthReleasePulled;
    account: AccountCredentialSource;
    accountId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    viewBounds?: { x: number; y: number; width: number; height: number };
    applyViewport?: (bounds: { width: number; height: number }) => void | Promise<void>;
    restoreViewport?: () => void | Promise<void>;
    downloadAsset?: AuthAssetDownloader;
  }) => Promise<AuthRunOutcome>;
};

export type BrowserOpenAuthDeps = {
  resolver: AuthScriptResolver;
  loader: AuthScriptLoader;
  runner: AuthRunnerLike;
  navigateToAuthUrl?: (url: string) => Promise<void>;
  downloadAsset?: AuthAssetDownloader;
  getViewBounds?: () => { x: number; y: number; width: number; height: number };
  applyViewport?: (bounds: { width: number; height: number }) => void | Promise<void>;
  restoreViewport?: () => void | Promise<void>;
};

/**
 * Authentication Script is optional secondary automation (WordPress POC).
 *
 * Per-execution policy (Master Context 19/11/2026):
 * 1. Checkpoint/session first.
 * 2. Session present → skip Auth (0 runs).
 * 3. Session absent → Auth at most once, then Checkpoint again.
 * 4. Auth fail OR post-Auth Checkpoint fail → stop; never Auth twice in same execution.
 * 5. No Auth pin / no Tag context → manual login path (still Checkpoint once).
 *
 * Tag context may come from explicit IPC or AuthContextFinder (Profile Open).
 * Same WebContents / partition — never a temp browser.
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
    runCheckpoint: (opts?: { settle?: boolean }) => Promise<SessionSignal>;
    signal?: AbortSignal;
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
    runCheckpoint: (opts?: { settle?: boolean }) => Promise<SessionSignal>;
    signal?: AbortSignal;
  }): Promise<AuthPipelineResult> {
    const { browserId, accountId, partition, tag, webContents, account, runCheckpoint, signal } =
      params;

    /** Hard cap: at most one Auth Script run for this Browser Open execution. */
    let authRuns = 0;

    if (!hasExplicitTagContext(tag)) {
      const signalCp = await runCheckpoint();
      logClientEvent("AUTH_SKIPPED", {
        reason: "NO_TAG_CONTEXT",
        browserId,
        accountId,
      });
      return checkpointResult("NO_TAG_CONTEXT", "skipped", signalCp, {
        message: "Không có Action Tag context — bỏ qua Auth Script (manual login).",
        authRuns,
      });
    }

    if (signal?.aborted) {
      const signalCp = await runCheckpoint();
      return checkpointResult("AUTH_CANCELLED", "skipped", signalCp, {
        message: "Auth bị hủy trước khi chạy.",
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        authRuns: 0,
      });
    }

    // 1) Session / Checkpoint first — never Auth when already logged in.
    // Settle so we do not false-negative while WP redirect/DOM is still settling.
    const initial = await runCheckpoint({ settle: true });
    logClientEvent("SESSION_CHECK", {
      browserId,
      accountId,
      partition,
      status: initial.status,
      method: initial.method,
      actionTagId: tag?.actionTagId,
      actionTagKey: tag?.actionTagKey,
    });

    if (initial.status === "present") {
      logClientEvent("AUTH_SKIPPED", {
        reason: "SESSION_VALID",
        browserId,
        accountId,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        authRuns: 0,
      });
      return {
        code: "SESSION_VALID",
        phase: "skipped",
        authExecutionOk: false,
        checkpointStatus: "present",
        message: "Session/Checkpoint hợp lệ — bỏ qua Authentication Script (0 lần).",
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        resolutionSource: tag?.resolutionSource,
        authRuns: 0,
      };
    }

    // UNKNOWN / error / unsupported are NOT "logged out" — do not auto-run Auth.
    if (
      initial.status === "unknown" ||
      initial.status === "error" ||
      initial.status === "unsupported"
    ) {
      logClientEvent("AUTH_SKIPPED", {
        reason: "SESSION_UNKNOWN",
        browserId,
        accountId,
        checkpointStatus: initial.status,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        authRuns: 0,
      });
      return {
        code: "SESSION_UNKNOWN",
        phase: "skipped",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: `Checkpoint ${initial.status} — không chạy Auth (không suy ra logout).`,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        resolutionSource: tag?.resolutionSource,
        authRuns: 0,
      };
    }

    logClientEvent("AUTH_RESOLVE", {
      browserId,
      accountId,
      partition,
      actionTagId: tag?.actionTagId,
      actionTagKey: tag?.actionTagKey,
      resolutionSource: tag?.resolutionSource ?? null,
      initialCheckpoint: initial.status,
    });

    const resolved = await this.deps.resolver.resolve(accountId, tag!);
    if (resolved.kind === "no_tag_context") {
      logClientEvent("AUTH_SKIPPED", { reason: "NO_TAG_CONTEXT", browserId, accountId });
      return checkpointResult("NO_TAG_CONTEXT", "skipped", initial, {
        message: "Không có Action Tag context — bỏ qua Auth Script.",
        authRuns,
      });
    }
    if (resolved.kind === "no_auth_configured") {
      logClientEvent("AUTH_SKIPPED", {
        reason: "NO_AUTH_CONFIGURED",
        browserId,
        accountId,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
      });
      return checkpointResult("NO_AUTH_CONFIGURED", "resolve", initial, {
        message: "Action Tag chưa gắn Auth pin — manual login.",
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        serverError: resolved.serverError,
        authRuns,
      });
    }
    if (resolved.kind === "error") {
      logClientEvent("AUTH_FAILED", {
        phase: "resolve",
        code: resolved.code,
        browserId,
        accountId,
        serverError: resolved.serverError,
      });
      return {
        code: resolved.code,
        phase: "resolve",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: resolved.message,
        serverError: resolved.serverError,
        actionTagId: tag?.actionTagId,
        actionTagKey: tag?.actionTagKey,
        authRuns,
      };
    }

    const expected = resolved.release;
    logClientEvent("AUTH_PULL", {
      browserId,
      accountId,
      packageKey: expected.package_key,
      releaseId: expected.release_id,
      version: expected.version,
      actionTagId: expected.action_tag_id,
      actionTagKey: expected.action_tag_key,
    });

    const loaded = await this.deps.loader.pullExact(accountId, tag!, expected);
    if (loaded.kind === "error") {
      logClientEvent("AUTH_FAILED", {
        phase: "pull",
        code: loaded.code,
        browserId,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
      });
      return {
        code: loaded.code,
        phase: "pull",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: loaded.message,
        serverError: loaded.serverError,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (!webContents || webContents.isDestroyed()) {
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "AUTH_EXECUTION_FAILED",
        reason: "webcontents_unavailable",
        browserId,
      });
      return {
        code: "AUTH_EXECUTION_FAILED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: "WebContents không sẵn sàng — không thể chạy Auth trong partition.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        authRuns,
      };
    }

    if (signal?.aborted) {
      return {
        code: "AUTH_CANCELLED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: "Auth bị hủy trước khi execute.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        authRuns: 0,
      };
    }

    const execCtx = resolved.executionContext ?? tag?.executionContext;
    if (execCtx?.resolvedUrl) {
      const validated = validateAuthNavigationTarget({
        targetUrl: execCtx.resolvedUrl,
        authorizedSiteUrl: execCtx.siteUrl ?? account.siteUrl,
        expectedAuthPath: execCtx.authPath,
      });
      if (!validated.ok) {
        logClientEvent("AUTH_FAILED", {
          phase: "execute",
          code: "AUTH_NAVIGATION_FAILED",
          browserId,
          reason: validated.reason,
        });
        return {
          code: "AUTH_NAVIGATION_FAILED",
          phase: "execute",
          authExecutionOk: false,
          checkpointStatus: initial.status,
          message: validated.reason,
          packageKey: expected.package_key,
          releaseId: expected.release_id,
          version: expected.version,
          contentDigest: expected.content_digest,
          actionTagId: expected.action_tag_id,
          actionTagKey: expected.action_tag_key,
          resolutionSource: tag?.resolutionSource,
          authRuns: 0,
        };
      }

      const currentUrl = typeof webContents.getURL === "function" ? webContents.getURL() : "";
      if (!isAtAuthTarget(currentUrl, validated)) {
        if (!this.deps.navigateToAuthUrl) {
          logClientEvent("AUTH_FAILED", {
            phase: "execute",
            code: "AUTH_NAVIGATION_FAILED",
            browserId,
            reason: "navigate_handler_unavailable",
          });
          return {
            code: "AUTH_NAVIGATION_FAILED",
            phase: "execute",
            authExecutionOk: false,
            checkpointStatus: initial.status,
            message: `Không thể điều hướng tới Auth URL (${validated.url}).`,
            packageKey: expected.package_key,
            releaseId: expected.release_id,
            version: expected.version,
            contentDigest: expected.content_digest,
            actionTagId: expected.action_tag_id,
            actionTagKey: expected.action_tag_key,
            resolutionSource: tag?.resolutionSource,
            authRuns: 0,
          };
        }
        try {
          logClientEvent("AUTH_NAVIGATE", {
            browserId,
            targetUrl: validated.url,
            actionTagKey: expected.action_tag_key,
            resolutionSource: tag?.resolutionSource ?? null,
          });
          await this.deps.navigateToAuthUrl(validated.url);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logClientEvent("AUTH_FAILED", {
            phase: "execute",
            code: "AUTH_NAVIGATION_FAILED",
            browserId,
            targetUrl: validated.url,
            reason,
          });
          return {
            code: "AUTH_NAVIGATION_FAILED",
            phase: "execute",
            authExecutionOk: false,
            checkpointStatus: initial.status,
            message: `Điều hướng tới Auth URL thất bại (${validated.url}): ${reason}`,
            packageKey: expected.package_key,
            releaseId: expected.release_id,
            version: expected.version,
            contentDigest: expected.content_digest,
            actionTagId: expected.action_tag_id,
            actionTagKey: expected.action_tag_key,
            resolutionSource: tag?.resolutionSource,
            authRuns: 0,
          };
        }

        const afterUrl = typeof webContents.getURL === "function" ? webContents.getURL() : "";
        if (afterUrl && !isAtAuthTarget(afterUrl, validated)) {
          logClientEvent("AUTH_FAILED", {
            phase: "execute",
            code: "AUTH_NAVIGATION_FAILED",
            browserId,
            expectedUrl: validated.url,
            actualUrl: afterUrl,
          });
          return {
            code: "AUTH_NAVIGATION_FAILED",
            phase: "execute",
            authExecutionOk: false,
            checkpointStatus: initial.status,
            message: `Trang sau điều hướng (${afterUrl}) không khớp Auth URL (${validated.url}).`,
            packageKey: expected.package_key,
            releaseId: expected.release_id,
            version: expected.version,
            contentDigest: expected.content_digest,
            actionTagId: expected.action_tag_id,
            actionTagKey: expected.action_tag_key,
            resolutionSource: tag?.resolutionSource,
            authRuns: 0,
          };
        }
      }
    }

    // 2) Exactly one Auth attempt for this execution.
    if (authRuns >= 1) {
      return {
        code: "AUTH_RETRY_FORBIDDEN",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message:
          "Authentication Script đã chạy trong execution này — không chạy lần hai.",
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    authRuns = 1;
    logClientEvent("AUTH_EXECUTION_STARTED", {
      browserId,
      packageKey: expected.package_key,
      releaseId: expected.release_id,
      version: expected.version,
      actionTagId: expected.action_tag_id,
      actionTagKey: expected.action_tag_key,
    });

    const run = await this.deps.runner.run({
      webContents,
      release: loaded.release,
      account,
      accountId,
      signal,
      viewBounds: this.deps.getViewBounds?.(),
      applyViewport: this.deps.applyViewport,
      restoreViewport: this.deps.restoreViewport,
      downloadAsset: this.deps.downloadAsset,
    });

    if (run.kind === "cancelled") {
      const afterFail = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "AUTH_CANCELLED",
        browserId,
        stepsExecuted: run.stepsExecuted,
      });
      return {
        code: "AUTH_CANCELLED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterFail.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "human_required") {
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "HUMAN_REQUIRED",
        browserId,
        stepsExecuted: run.stepsExecuted,
      });
      return {
        code: "HUMAN_REQUIRED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: initial.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "orc_unavailable") {
      const afterOrc = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "ORC_RUNTIME_UNAVAILABLE",
        browserId,
        stepIndex: run.stepIndex,
        stepsExecuted: run.stepsExecuted,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        checkpointStatus: afterOrc.status,
      });
      return {
        code: "ORC_RUNTIME_UNAVAILABLE",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterOrc.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "asset_unavailable") {
      const afterAsset = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: run.code,
        browserId,
        stepsExecuted: run.stepsExecuted,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        checkpointStatus: afterAsset.status,
      });
      return {
        code: run.code,
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterAsset.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "viewport_mismatch") {
      const afterVp = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "VIEWPORT_MISMATCH",
        browserId,
        stepIndex: run.stepIndex,
        stepsExecuted: run.stepsExecuted,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        checkpointStatus: afterVp.status,
      });
      return {
        code: "VIEWPORT_MISMATCH",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterVp.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "timeout") {
      const afterFail = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "AUTH_TIMEOUT",
        browserId,
        stepsExecuted: run.stepsExecuted,
      });
      return {
        code: "AUTH_TIMEOUT",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterFail.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    if (run.kind === "error") {
      const afterFail = await runCheckpoint();
      logClientEvent("AUTH_FAILED", {
        phase: "execute",
        code: "AUTH_EXECUTION_FAILED",
        browserId,
        stepsExecuted: run.stepsExecuted,
      });
      return {
        code: "AUTH_EXECUTION_FAILED",
        phase: "execute",
        authExecutionOk: false,
        checkpointStatus: afterFail.status,
        message: run.message,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        contentDigest: expected.content_digest,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    // 3) Auth steps finished ≠ login success — Checkpoint is authoritative.
    // Wait for WP redirect + cookies/DOM; do not conclude absent mid-navigation.
    const cp = await runCheckpoint({ settle: true });
    logClientEvent("SESSION_CHECK", {
      browserId,
      accountId,
      partition,
      phase: "post_auth",
      status: cp.status,
      method: cp.method,
    });

    if (cp.status === "present") {
      logClientEvent("AUTH_CHECKPOINT_PASSED", {
        browserId,
        packageKey: expected.package_key,
        releaseId: expected.release_id,
        version: expected.version,
        actionTagId: expected.action_tag_id,
        actionTagKey: expected.action_tag_key,
        authRuns,
      });
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
        resolutionSource: tag?.resolutionSource,
        authRuns,
      };
    }

    logClientEvent("AUTH_FAILED", {
      phase: "checkpoint",
      code: "CHECKPOINT_FAILED",
      browserId,
      checkpointStatus: cp.status,
      authRuns,
    });
    return {
      code: "CHECKPOINT_FAILED",
      phase: "checkpoint",
      authExecutionOk: true,
      checkpointStatus: cp.status,
      message:
        "Auth Script đã chạy 1 lần nhưng Checkpoint chưa xác nhận login — dừng, không retry Auth.",
      packageKey: expected.package_key,
      releaseId: expected.release_id,
      version: expected.version,
      contentDigest: expected.content_digest,
      actionTagId: expected.action_tag_id,
      actionTagKey: expected.action_tag_key,
      authRuns,
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
