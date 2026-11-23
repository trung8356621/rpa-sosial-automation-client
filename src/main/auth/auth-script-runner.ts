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
            return {
              kind: "error",
              message: `Step ${i}: ${out.message}`,
              stepsExecuted,
              stepIndex: i,
              code: failureCode,
              confirmedNotFound,
              mutated,
            };
          }
        }

        stepsExecuted += 1;
        logClientEvent("AUTH_STEP_COMPLETED", {
          packageKey: release.package_key,
          releaseId: release.release_id,
          version: release.version,
          stepIndex: i,
          action: normalizeAuthAction(step.action),
          kind,
          stepsExecuted,
        });

        const human = await detectHumanRequired(webContents, {
          jobId: params.jobId,
          attemptId: params.attemptId,
          stepIndex: i,
        });
        if (human) {
          return { kind: "human_required", message: human, stepsExecuted };
        }
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

export type HumanRequiredDetectionOutcome = "CONFIRMED" | "UNCERTAIN" | "NONE";

export type HumanRequiredDetectionResult = {
  outcome: HumanRequiredDetectionOutcome;
  ruleId: string;
  evidence: string;
};

export const HUMAN_REQUIRED_DETECTION_SCRIPT = `(() => {
  const queryAll = (sel) => {
    if (typeof document.querySelectorAll === 'function') {
      return Array.from(document.querySelectorAll(sel) || []);
    }
    const single = typeof document.querySelector === 'function' ? document.querySelector(sel) : null;
    return single ? [single] : [];
  };

  const getStyle = (el) =>
    el && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el)
      : null;

  const isNodeHidden = (node) => {
    if (!node) return false;
    if (node.classList?.contains('hidden')) return true;
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return true;
    if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return true;
    if (String(node.tagName || '').toUpperCase() === 'DIALOG' && node.open === false) return true;
    const style = getStyle(node);
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    ) {
      return true;
    }
    return false;
  };

  const inspectVisible = (el) => {
    if (!el) return { visible: false, reason: 'missing' };
    if (typeof el.isConnected === 'boolean' && !el.isConnected) {
      return { visible: false, reason: 'disconnected' };
    }
    let cur = el;
    let depth = 0;
    while (cur && depth < 32) {
      if (isNodeHidden(cur)) {
        return { visible: false, reason: 'hidden_or_inactive' };
      }
      cur = cur.parentElement || null;
      depth += 1;
    }
    if (typeof el.closest === 'function') {
      const wpWrap = el.closest('#wp-auth-check-wrap');
      if (wpWrap && isNodeHidden(wpWrap)) {
        return { visible: false, reason: 'wp_auth_check_wrap_hidden' };
      }
      const closedDialog = el.closest('dialog:not([open]), [aria-hidden="true"], .hidden, [hidden]');
      if (closedDialog && isNodeHidden(closedDialog)) {
        return { visible: false, reason: 'inactive_ancestor' };
      }
    }
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (rect && (rect.width <= 0 || rect.height <= 0)) {
      return { visible: false, reason: 'zero_size' };
    }
    const rectSummary = rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : 'no_rect';
    return { visible: true, reason: 'visible:' + rectSummary };
  };

  const isIgnoredAdminContext = (el) => {
    if (!el || typeof el.closest !== 'function') return false;
    return Boolean(
      el.closest('.notice, .notice-info, .notice-warning, .notice-error, .update-nag, #wpadminbar, #adminmenu, #titlewrap, #postdivrich, [contenteditable="true"]')
    );
  };

  // 1. WordPress interim login modal (#wp-auth-check) — only when actually visible.
  for (const wpAuth of queryAll('#wp-auth-check')) {
    const vis = inspectVisible(wpAuth);
    if (vis.visible) {
      return {
        outcome: 'CONFIRMED',
        ruleId: 'wp_auth_check_visible',
        evidence: 'selector=#wp-auth-check, ' + vis.reason,
      };
    }
  }

  // 2. Active CAPTCHA / challenge widgets — must be connected and visible.
  const challengeSelectors = [
    '#captcha',
    '.g-recaptcha',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '.h-captcha',
    '.cf-turnstile',
    '.cf-challenge',
    '#cf-challenge-running',
    '[data-callback*="captcha"]',
  ];
  for (const sel of challengeSelectors) {
    for (const el of queryAll(sel)) {
      if (isIgnoredAdminContext(el)) continue;
      const vis = inspectVisible(el);
      if (vis.visible) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_ui',
          evidence: 'selector=' + sel + ', ' + vis.reason,
        };
      }
    }
  }

  // 3. Context-aware challenge text inside visible active dialogs / challenge containers.
  const dialogSelectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    'dialog[open]',
    '.cf-challenge',
    '#challenge-form',
    '#challenge-stage',
  ];
  const strongChallengeRe = /verify you are human|complete the captcha|security check|human verification|please verify you/i;
  for (const sel of dialogSelectors) {
    for (const el of queryAll(sel)) {
      if (isIgnoredAdminContext(el)) continue;
      const vis = inspectVisible(el);
      if (!vis.visible) continue;
      const txt = String(el.innerText || el.textContent || '');
      if (strongChallengeRe.test(txt)) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_text_dialog',
          evidence: 'container=' + sel + ', ' + vis.reason,
        };
      }
    }
  }

  // 4. Standalone interstitial text (outside WordPress admin notices/editor/chrome).
  const body = document.body;
  if (body && typeof body.innerText === 'string') {
    const isWpAdminShell = Boolean(
      (typeof document.querySelector === 'function' && (document.querySelector('#wpadminbar') || document.querySelector('#wpcontent')))
    );
    if (!isWpAdminShell) {
      const bodyText = body.innerText.toLowerCase();
      if (bodyText.includes('verify you are human')) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_text',
          evidence: 'standalone_interstitial=verify_you_are_human',
        };
      }
      if (bodyText.includes('captcha')) {
        return {
          outcome: 'UNCERTAIN',
          ruleId: 'weak_captcha_text_signal',
          evidence: 'standalone_text=captcha_without_visible_widget',
        };
      }
    }
  }

  return { outcome: 'NONE', ruleId: 'none', evidence: 'no_active_challenge' };
})()`;

async function detectHumanRequired(
  webContents: WebContents,
  ctx?: { jobId?: string; attemptId?: string; stepIndex?: number }
): Promise<string | null> {
  try {
    const raw = await webContents.executeJavaScript(HUMAN_REQUIRED_DETECTION_SCRIPT, true);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const result = raw as Partial<HumanRequiredDetectionResult>;
    if (result.outcome === "CONFIRMED") {
      const ruleId = String(result.ruleId || "captcha_or_verification_ui");
      logClientEvent("HUMAN_REQUIRED_DETECTION", {
        jobId: ctx?.jobId ?? null,
        attemptId: ctx?.attemptId ?? null,
        stepIndex: ctx?.stepIndex ?? null,
        outcome: "CONFIRMED",
        ruleId,
        evidence: String(result.evidence || ""),
        blocked: true,
      });
      return `HUMAN_REQUIRED: phát hiện xác minh/CAPTCHA (${ruleId}) — không bypass.`;
    }
    if (result.outcome === "UNCERTAIN") {
      logClientEvent("HUMAN_REQUIRED_DETECTION", {
        jobId: ctx?.jobId ?? null,
        attemptId: ctx?.attemptId ?? null,
        stepIndex: ctx?.stepIndex ?? null,
        outcome: "UNCERTAIN",
        ruleId: String(result.ruleId || "ambiguous_signal"),
        evidence: String(result.evidence || ""),
        blocked: false,
      });
      return null;
    }
  } catch {
    // ignore detection failures
  }
  return null;
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
