import type { WebContents } from "electron";
import type { AuthReleasePulled, AuthScriptStep, AuthScriptVariable } from "./auth-script-types.js";
import {
  redactSecretsForLog,
  resolveCredentialBindings,
  type AccountCredentialSource,
} from "./credential-mapper.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import {
  classifyAuthStep,
  normalizeAuthAction,
  resolveDomSelector,
  sanitizeStepMeta,
} from "./auth-step-classify.js";
import {
  OrcAssetStore,
  type AuthAssetDownloader,
  type ManifestAsset,
} from "../orc/asset-store.js";
import { VisualOrcExecutor } from "../orc/visual-executor.js";
import { authStepToVisualPayload } from "../orc/step-to-payload.js";
import type { Rect } from "../orc/contracts.js";

export type AuthExecutionProgressEvent =
  | {
      kind: "step_phase";
      stepNumber: number;
      totalSteps: number;
      phase: "OCR" | "Click" | "Type" | "Wait" | "Scroll" | "DOM";
    }
  | {
      kind: "step_failed";
      stepNumber: number;
      totalSteps: number;
      code: string;
    };

export type AuthRunOutcome =
  | { kind: "ok"; stepsExecuted: number }
  | { kind: "timeout"; message: string; stepsExecuted: number }
  | { kind: "cancelled"; message: string; stepsExecuted: number }
  | { kind: "human_required"; message: string; stepsExecuted: number }
  | { kind: "orc_unavailable"; message: string; stepsExecuted: number; stepIndex: number }
  | {
      kind: "asset_unavailable";
      message: string;
      stepsExecuted: number;
      code: "ASSET_DOWNLOAD_UNAVAILABLE" | "ASSET_INTEGRITY_FAILED" | "ASSET_MISSING";
    }
  | { kind: "viewport_mismatch"; message: string; stepsExecuted: number; stepIndex: number }
  | {
      kind: "error";
      message: string;
      stepsExecuted: number;
      stepIndex?: number;
      code?: string;
      confirmedNotFound?: boolean;
      mutated?: boolean;
    };

const DEFAULT_TIMEOUT_MS = 120_000;
const CREATOR_VIEWPORT: Rect = { x: 0, y: 0, width: 1024, height: 560 };

/**
 * Shared Auth/Action execution entry: DOM steps + Creator Visual ORC.
 * Visual path uses vendored ORC core (Admin baseline 8c06ef86) — not a second engine.
 */
export class AuthScriptRunner {
  constructor(
    private readonly assetStore: OrcAssetStore = new OrcAssetStore(),
  ) {}

  async run(params: {
    webContents: WebContents;
    release: AuthReleasePulled;
    account: AccountCredentialSource;
    accountId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** DIP bounds of embedded browser view — resized to Creator env when needed. */
    viewBounds?: Rect;
    /** Apply temporary viewport during ORC (restore after). */
    applyViewport?: (bounds: { width: number; height: number }) => void | Promise<void>;
    restoreViewport?: () => void | Promise<void>;
    downloadAsset?: AuthAssetDownloader;
    /** Job/campaign input bindings (e.g. title) merged after credential resolve. */
    inputValues?: Record<string, string>;
    jobId?: string;
    attemptId?: string;
    onProgress?: (event: AuthExecutionProgressEvent) => void;
    onVisualStepFailure?: (failure: {
      stepIndex: number;
      code: string;
      canRetry: boolean;
      deadline: number;
    }) => Promise<"verified" | "unresolved" | "unresolved_after_handler">;
  }): Promise<AuthRunOutcome> {
    const { webContents, release, account, signal } = params;
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const manifest = release.manifest;
    const steps = Array.isArray(manifest.steps) ? (manifest.steps as AuthScriptStep[]) : [];
    const variables = Array.isArray(manifest.variables)
      ? (manifest.variables as AuthScriptVariable[])
      : [];

    if (steps.length === 0) {
      return { kind: "error", message: "Auth manifest không có steps", stepsExecuted: 0 };
    }

    const classifications = steps.map((s, i) => ({
      i,
      c: classifyAuthStep(s),
      meta: sanitizeStepMeta(s, i),
    }));
    logClientEvent("AUTH_STEP_CLASSIFIED", {
      packageKey: release.package_key,
      releaseId: release.release_id,
      version: release.version,
      steps: classifications.map((x) => x.meta),
      orcBaseline: "8c06ef86179d7f90c21bdba81bf6a768227e148e",
    });

    for (const { i, c } of classifications) {
      if (c.kind === "unsupported") {
        return { kind: "error", message: `Step ${i}: ${c.reason}`, stepsExecuted: 0 };
      }
    }

    const needsOrc = classifications.some((x) => x.c.kind === "orc_visual");
    let templates: Map<string, Buffer> | null = null;

    if (needsOrc) {
      if (!params.downloadAsset) {
        return {
          kind: "asset_unavailable",
          code: "ASSET_DOWNLOAD_UNAVAILABLE",
          message:
            "CONTRACT GAP: Visual ORC requires Client asset download (POST /client/auth/asset). Auth runner has ORC core but no download adapter wired.",
          stepsExecuted: 0,
        };
      }
      const assets = Array.isArray(manifest.assets)
        ? (manifest.assets as ManifestAsset[])
        : [];
      if (assets.length === 0) {
        return {
          kind: "asset_unavailable",
          code: "ASSET_MISSING",
          message: "Visual ORC manifest có steps nhưng không khai báo assets[].",
          stepsExecuted: 0,
        };
      }
      const loaded = await this.assetStore.ensureAssets({
        accountId: params.accountId || account.accountId,
        packageKey: release.package_key,
        version: release.version,
        releaseId: release.release_id,
        assets,
        download: params.downloadAsset,
      });
      if (!loaded.ok) {
        return {
          kind: "asset_unavailable",
          code: loaded.code as
            | "ASSET_DOWNLOAD_UNAVAILABLE"
            | "ASSET_INTEGRITY_FAILED"
            | "ASSET_MISSING",
          message: loaded.message,
          stepsExecuted: 0,
        };
      }
      templates = loaded.byPath;
    }

    const bindings = await resolveCredentialBindings(variables, account);
    if (!bindings.ok) {
      return { kind: "error", message: bindings.message, stepsExecuted: 0 };
    }
    if (params.inputValues) {
      for (const [key, value] of Object.entries(params.inputValues)) {
        if (key && typeof value === "string") {
          bindings.values[key] = value;
        }
      }
    }

    logClientEvent("AUTH_EXECUTION_STARTED", {
      packageKey: release.package_key,
      version: release.version,
      releaseId: release.release_id,
      stepCount: steps.length,
      variableKeys: variables.map((v) => v.key).filter(Boolean),
      mode: needsOrc ? "dom+orc" : "dom",
    });

    let stepsExecuted = 0;
    const deadline = Date.now() + timeoutMs;
    let viewportApplied = false;

    try {
      if (needsOrc && params.applyViewport) {
        // Creator default execution viewport (environment may refine per-step).
        await params.applyViewport({
          width: CREATOR_VIEWPORT.width,
          height: CREATOR_VIEWPORT.height,
        });
        viewportApplied = true;
      }

      const viewBounds: Rect = params.viewBounds
        ? { ...params.viewBounds }
        : needsOrc
          ? { ...CREATOR_VIEWPORT }
          : { x: 0, y: 0, width: 1024, height: 560 };

      const orc =
        needsOrc && templates
          ? VisualOrcExecutor.fromWebContents(webContents, {
              x: 0,
              y: 0,
              width: viewBounds.width || CREATOR_VIEWPORT.width,
              height: viewBounds.height || CREATOR_VIEWPORT.height,
            })
          : null;

      let recoveryUsed = false;
      let recoveryFailure: Extract<AuthRunOutcome, { kind: "error" }> | undefined;
      for (let i = 0; i < steps.length; i++) {
        if (signal?.aborted) {
          return {
            kind: "cancelled",
            message: "Auth Script bị hủy bởi người dùng.",
            stepsExecuted,
          };
        }
        if (Date.now() > deadline) {
          return {
            kind: "timeout",
            message: `Auth Script timeout sau ${timeoutMs}ms`,
            stepsExecuted,
          };
        }

        const step = steps[i];
        const kind = classifications[i].c.kind;
        const stepNumber = i + 1;
        const totalSteps = steps.length;

        if (kind === "dom") {
          params.onProgress?.({ kind: "step_phase", stepNumber, totalSteps, phase: "DOM" });
          await executeDomStep(webContents, step, bindings.values, deadline);
        } else if (kind === "orc_visual") {
          if (!orc || !templates) {
            return {
              kind: "orc_unavailable",
              message: `Step ${i}: ORC executor not initialized`,
              stepsExecuted,
              stepIndex: i,
            };
          }
          const payload = authStepToVisualPayload(step);
          if (!payload?.target?.asset) {
            return {
              kind: "error",
              message: `Step ${i}: không map được Creator visual payload`,
              stepsExecuted,
            };
          }
          const template = this.assetStore.resolveTemplate(templates, payload.target.asset);
          if (!template) {
            return {
              kind: "asset_unavailable",
              code: "ASSET_MISSING",
              message: `Step ${i}: thiếu asset binary ${payload.target.asset}`,
              stepsExecuted,
            };
          }
          const varKey = String(step.variable_key || step.variable || "").trim();
          const text =
            (varKey && bindings.values[varKey]) ||
            (typeof step.value === "string" ? step.value : undefined) ||
            payload.text;
          logClientEvent("STEP_INPUT_RESOLVED", {
            stepIndex: i,
            action: normalizeAuthAction(step.action),
            variableKey: varKey || null,
            variablePresent: Boolean(text),
            valueLength: typeof text === "string" ? text.length : 0,
          });

          // Per-step environment may request exact Creator size.
          if (payload.target.environment && params.applyViewport) {
            await params.applyViewport({
              width: payload.target.environment.width,
              height: payload.target.environment.height,
            });
            orc.setBounds({
              x: 0,
              y: 0,
              width: payload.target.environment.width,
              height: payload.target.environment.height,
            });
          }

          if (
            payload.action === "WAIT_VERIFY" ||
            payload.action === "SLEEP"
          ) {
            params.onProgress?.({ kind: "step_phase", stepNumber, totalSteps, phase: "Wait" });
          } else if (payload.action === "SCROLL") {
            params.onProgress?.({ kind: "step_phase", stepNumber, totalSteps, phase: "Scroll" });
          }

          const out = await orc.executeVisualStep({
            payload,
            template,
            text,
            stepId: typeof step.id === "string" ? step.id : `step-${i}`,
            stepName: typeof step.name === "string" ? step.name : undefined,
            authorizedSiteUrl: params.account.siteUrl,
            signal,
            onPhase: (phase) => {
              params.onProgress?.({
                kind: "step_phase",
                stepNumber,
                totalSteps,
                phase: phase === "ocr" ? "OCR" : phase === "click" ? "Click" : "Type",
              });
            },
          });
          if (out.kind === "blocked" && out.code === "CANCELLED") {
            return {
              kind: "cancelled",
              message: out.message,
              stepsExecuted,
            };
          }
          if (out.kind === "blocked" && out.code === "VIEWPORT_MISMATCH") {
            params.onProgress?.({
              kind: "step_failed",
              stepNumber,
              totalSteps,
              code: "VIEWPORT_MISMATCH",
            });
            return {
              kind: "viewport_mismatch",
              message: `Step ${i}: ${out.message}`,
              stepsExecuted,
              stepIndex: i,
            };
          }
          if (out.kind !== "ok") {
            const mutated =
              i > 0 || stepsExecuted > 0 || (out.mutated ?? false);
            const confirmedNotFound =
              !mutated &&
              out.kind === "blocked" &&
              out.confirmedNotFound === true;
            const failureCode = out.kind === "blocked" ? out.code : "ORC_ERROR";
            logClientEvent("STEP_FAILED", {
              stepIndex: i,
              stepNumber,
              code: failureCode,
            });
            params.onProgress?.({
              kind: "step_failed",
              stepNumber,
              totalSteps,
              code: failureCode,
            });
            const failure = {
              kind: "error" as const,
              message: `Step ${i}: ${out.message}`,
              stepsExecuted,
              stepIndex: i,
              code: failureCode,
              confirmedNotFound,
              mutated,
            };
            if (recoveryFailure) return recoveryFailure;
            if (params.onVisualStepFailure && !recoveryUsed && !signal?.aborted && Date.now() < deadline) {
              const canRetry = payload.action === "WAIT_VERIFY";
              let recovery: "verified" | "unresolved" | "unresolved_after_handler";
              try {
                recovery = await params.onVisualStepFailure({ stepIndex: i, code: failureCode, canRetry, deadline });
              } catch {
                logClientEvent("VISUAL_STEP_FAILURE_CALLBACK_FAILED", { stepIndex: i, code: failureCode });
                recovery = "unresolved_after_handler";
              }
              if (recovery !== "unresolved") {
                failure.confirmedNotFound = false;
                failure.mutated = true;
              }
              if (canRetry && recovery === "verified" && !signal?.aborted && Date.now() < deadline) {
                recoveryUsed = true;
                recoveryFailure = failure;
                i -= 1;
                continue;
              }
            }
            return failure;
          }
        }

        stepsExecuted += 1;
        recoveryFailure = undefined;
        logClientEvent("AUTH_STEP_COMPLETED", {
          packageKey: release.package_key,
          releaseId: release.release_id,
          version: release.version,
          stepIndex: i,
          action: normalizeAuthAction(step.action),
          kind,
          stepsExecuted,
        });
      }
      return { kind: "ok", stepsExecuted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (signal?.aborted || /aborted|cancelled/i.test(message)) {
        return {
          kind: "cancelled",
          message: "Auth Script bị hủy bởi người dùng.",
          stepsExecuted,
        };
      }
      logClientError("Auth Script execution failed", {
        packageKey: release.package_key,
        releaseId: release.release_id,
        stepsExecuted,
        error: String(redactSecretsForLog(message)),
      });
      return { kind: "error", message, stepsExecuted };
    } finally {
      if (viewportApplied && params.restoreViewport) {
        try {
          await params.restoreViewport();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** @deprecated Prefer classifyAuthStep — kept for tests / callers. */
export function describeUnsupportedStep(step: AuthScriptStep): string | null {
  const c = classifyAuthStep(step);
  if (c.kind === "dom") return null;
  if (c.kind === "orc_visual") {
    return `ORC_RUNTIME_UNAVAILABLE: ${c.reason}`;
  }
  return c.reason;
}

/** @deprecated Prefer resolveDomSelector */
export function resolveSelector(step: AuthScriptStep): string {
  return resolveDomSelector(step);
}

async function executeDomStep(
  webContents: WebContents,
  step: AuthScriptStep,
  values: Record<string, string>,
  deadline: number
): Promise<void> {
  const action = normalizeAuthAction(step.action);
  const remaining = () => Math.max(0, deadline - Date.now());

  if (action === "navigate" || action === "goto" || action === "open_url") {
    const url = resolveStepValue(step, values, "url");
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error("navigate step cần URL http(s) hợp lệ");
    }
    await webContents.loadURL(url);
    return;
  }

  if (action === "wait" || action === "wait_ms") {
    const selector = resolveDomSelector(step);
    const ms = Number(step.ms ?? step.timeout_ms ?? 500);
    if (selector) {
      await waitForSelector(webContents, selector, Math.min(remaining(), Math.max(ms, 1000)));
    } else {
      await sleep(Math.min(ms, remaining()));
    }
    return;
  }

  if (action === "fill" || action === "type" || action === "type_text") {
    const selector = resolveDomSelector(step);
    const value = resolveStepValue(step, values);
    await waitForSelector(webContents, selector, Math.min(remaining(), 15_000));
    await webContents.executeJavaScript(
      `(${fillFn.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`,
      true
    );
    return;
  }

  if (action === "click" || action === "click_target") {
    const selector = resolveDomSelector(step);
    await waitForSelector(webContents, selector, Math.min(remaining(), 15_000));
    await webContents.executeJavaScript(`(${clickFn.toString()})(${JSON.stringify(selector)})`, true);
    return;
  }

  if (action === "submit") {
    const selector = resolveDomSelector(step) || "form";
    await waitForSelector(webContents, selector, Math.min(remaining(), 15_000));
    await webContents.executeJavaScript(`(${submitFn.toString()})(${JSON.stringify(selector)})`, true);
    return;
  }

  throw new Error(`Unsupported action ${action}`);
}

function resolveStepValue(
  step: AuthScriptStep,
  values: Record<string, string>,
  literalField: "url" | "value" = "value"
): string {
  const varKey = String(step.variable_key || step.variable || "").trim();
  if (varKey && Object.prototype.hasOwnProperty.call(values, varKey)) {
    return values[varKey];
  }
  const literal = step[literalField];
  if (typeof literal === "string") return literal;
  if (literalField === "value" && typeof step.url === "string") return step.url;
  if (varKey) {
    throw new Error(`Biến chưa được bind: ${varKey}`);
  }
  return "";
}

async function waitForSelector(webContents: WebContents, selector: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true
    );
    if (found) return;
    await sleep(150);
  }
  throw new Error(`Timeout chờ selector`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fillFn(selector: string, value: string): boolean {
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error("element not found");
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function clickFn(selector: string): boolean {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error("element not found");
  el.click();
  return true;
}

function submitFn(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) throw new Error("element not found");
  if (el instanceof HTMLFormElement) {
    el.requestSubmit();
    return true;
  }
  const form = el.closest("form");
  if (form) {
    form.requestSubmit();
    return true;
  }
  (el as HTMLElement).click();
  return true;
}
