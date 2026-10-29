import type { WebContents } from "electron";
import type { AuthReleasePulled, AuthScriptStep, AuthScriptVariable } from "./auth-script-types.js";
import {
  redactSecretsForLog,
  resolveCredentialBindings,
  type AccountCredentialSource,
} from "./credential-mapper.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export type AuthRunOutcome =
  | { kind: "ok"; stepsExecuted: number }
  | { kind: "timeout"; message: string; stepsExecuted: number }
  | { kind: "error"; message: string; stepsExecuted: number };

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Executes Auth Script steps through the SAME Browser WebContents (same partition).
 * WordPress-first: DOM selector actions only. OCR / image Match-To steps fail closed.
 */
export class AuthScriptRunner {
  async run(params: {
    webContents: WebContents;
    release: AuthReleasePulled;
    account: AccountCredentialSource;
    timeoutMs?: number;
  }): Promise<AuthRunOutcome> {
    const { webContents, release, account } = params;
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const manifest = release.manifest;
    const steps = Array.isArray(manifest.steps) ? (manifest.steps as AuthScriptStep[]) : [];
    const variables = Array.isArray(manifest.variables)
      ? (manifest.variables as AuthScriptVariable[])
      : [];

    if (steps.length === 0) {
      return { kind: "error", message: "Auth manifest không có steps", stepsExecuted: 0 };
    }

    for (let i = 0; i < steps.length; i++) {
      const unsupported = describeUnsupportedStep(steps[i]);
      if (unsupported) {
        return {
          kind: "error",
          message: `Step ${i}: ${unsupported}`,
          stepsExecuted: 0,
        };
      }
    }

    const bindings = await resolveCredentialBindings(variables, account);
    if (!bindings.ok) {
      return { kind: "error", message: bindings.message, stepsExecuted: 0 };
    }

    logClientEvent("Auth Script execution starting", {
      packageKey: release.package_key,
      version: release.version,
      releaseId: release.release_id,
      stepCount: steps.length,
      // Never log binding values
      variableKeys: variables.map((v) => v.key).filter(Boolean),
    });

    let stepsExecuted = 0;
    const deadline = Date.now() + timeoutMs;

    try {
      for (let i = 0; i < steps.length; i++) {
        if (Date.now() > deadline) {
          return {
            kind: "timeout",
            message: `Auth Script timeout sau ${timeoutMs}ms`,
            stepsExecuted,
          };
        }
        const step = steps[i];
        await executeDomStep(webContents, step, bindings.values, deadline);
        stepsExecuted += 1;
      }
      return { kind: "ok", stepsExecuted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logClientError("Auth Script execution failed", {
        packageKey: release.package_key,
        releaseId: release.release_id,
        stepsExecuted,
        // Sanitize any accidental secret leakage in error messages
        error: String(redactSecretsForLog(message)),
      });
      return { kind: "error", message, stepsExecuted };
    }
  }
}

export function describeUnsupportedStep(step: AuthScriptStep): string | null {
  if (!step || typeof step !== "object") return "step không hợp lệ";
  for (const forbidden of ["code", "executable", "eval", "account_switch", "switch_account", "change_account"]) {
    if (Object.prototype.hasOwnProperty.call(step, forbidden)) {
      return `forbidden field ${forbidden}`;
    }
  }
  const target = step.target;
  if (target && typeof target === "object") {
    const matchTo = (target as { matchTo?: unknown }).matchTo;
    if (matchTo === "top" || matchTo === "middle" || matchTo === "bottom") {
      return "OCR/image Match-To không được dùng cho WordPress-first Auth (DOM only)";
    }
    if ((target as { ocr?: unknown }).ocr) {
      return "OCR target không được hỗ trợ trong Auth runner DOM-first";
    }
    if ((target as { image?: unknown }).image || (target as { template?: unknown }).template) {
      return "Image template target không được hỗ trợ trong Auth runner DOM-first";
    }
  }
  const action = normalizeAction(step.action);
  if (!action) return "thiếu action";
  if (!SUPPORTED_ACTIONS.has(action)) {
    return `action không hỗ trợ: ${action}`;
  }
  if ((action === "fill" || action === "type" || action === "click" || action === "submit") && !resolveSelector(step)) {
    return `action ${action} cần CSS selector`;
  }
  return null;
}

const SUPPORTED_ACTIONS = new Set([
  "navigate",
  "goto",
  "open_url",
  "fill",
  "type",
  "type_text",
  "click",
  "click_target",
  "wait",
  "wait_ms",
  "submit",
]);

function normalizeAction(action: unknown): string {
  return String(action || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function resolveSelector(step: AuthScriptStep): string {
  return String(step.selector || step.css || "").trim();
}

async function executeDomStep(
  webContents: WebContents,
  step: AuthScriptStep,
  values: Record<string, string>,
  deadline: number
): Promise<void> {
  const action = normalizeAction(step.action);
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
    const selector = resolveSelector(step);
    const ms = Number(step.ms ?? step.timeout_ms ?? 500);
    if (selector) {
      await waitForSelector(webContents, selector, Math.min(remaining(), Math.max(ms, 1000)));
    } else {
      await sleep(Math.min(ms, remaining()));
    }
    return;
  }

  if (action === "fill" || action === "type" || action === "type_text") {
    const selector = resolveSelector(step);
    const value = resolveStepValue(step, values);
    await waitForSelector(webContents, selector, Math.min(remaining(), 15_000));
    await webContents.executeJavaScript(
      `(${fillFn.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`,
      true
    );
    return;
  }

  if (action === "click" || action === "click_target") {
    const selector = resolveSelector(step);
    await waitForSelector(webContents, selector, Math.min(remaining(), 15_000));
    await webContents.executeJavaScript(`(${clickFn.toString()})(${JSON.stringify(selector)})`, true);
    return;
  }

  if (action === "submit") {
    const selector = resolveSelector(step) || "form";
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
    if (typeof el.requestSubmit === "function") el.requestSubmit();
    else el.submit();
    return true;
  }
  const form = (el as HTMLElement).closest("form");
  if (form) {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  }
  (el as HTMLElement).click();
  return true;
}
