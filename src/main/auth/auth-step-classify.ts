import type { AuthScriptStep } from "./auth-script-types.js";

/**
 * Classify Script Creator / Auth manifest steps for Client execution.
 *
 * Script Creator (rpa-social-automation-v2) exports visual ORC steps:
 *   action: CLICK_TARGET | CLICK_AND_TYPE | TYPE_ONLY | WAIT_VERIFY | UPLOAD_FILE | SCROLL
 *   target: { asset, roi, matchTo?, ocr?, environment? }
 *
 * DOM-compatible Auth steps (flat or target.css/selector) are a separate path.
 * Presence of target.ocr alone does NOT force ORC when a real CSS selector exists
 * and the action is DOM-compatible — OCR may be Creator metadata / fallback.
 * Never invent CSS from OCR text.
 */

export type AuthStepExecutionKind = "dom" | "orc_visual" | "unsupported";

export type AuthStepClassification = {
  kind: AuthStepExecutionKind;
  action: string;
  hasCssSelector: boolean;
  hasOcr: boolean;
  hasImageAsset: boolean;
  matchTo: string | null;
  /** Safe diagnostic — no credential values. */
  reason: string;
};

const DOM_ACTIONS = new Set([
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

/** Script Creator visual ORC actions (coordinate / image / OCR resolution). */
const ORC_VISUAL_ACTIONS = new Set([
  "click_target", // ambiguous name — disambiguated by target shape below
  "click_and_type",
  "type_only",
  "wait_verify",
  "upload_file",
  "scroll",
]);

const FORBIDDEN_FIELDS = [
  "code",
  "executable",
  "eval",
  "account_switch",
  "switch_account",
  "change_account",
];

export function normalizeAuthAction(action: unknown): string {
  return String(action || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

/**
 * Resolve CSS selector from flat fields or nested target — does not invent from OCR.
 */
export function resolveDomSelector(step: AuthScriptStep): string {
  const direct = String(step.selector || step.css || "").trim();
  if (direct) return direct;
  const target = step.target;
  if (target && typeof target === "object") {
    const nested = String(
      (target as { selector?: unknown; css?: unknown; query?: unknown }).selector ||
        (target as { css?: unknown }).css ||
        (target as { query?: unknown }).query ||
        ""
    ).trim();
    if (nested) return nested;
  }
  const payload = (step as { payload?: Record<string, unknown> }).payload;
  if (payload && typeof payload === "object") {
    const fromPayload = String(payload.selector || payload.css || "").trim();
    if (fromPayload) return fromPayload;
    const pt = payload.target;
    if (pt && typeof pt === "object") {
      const nested = String(
        (pt as { selector?: unknown; css?: unknown; query?: unknown }).selector ||
          (pt as { css?: unknown }).css ||
          (pt as { query?: unknown }).query ||
          ""
      ).trim();
      if (nested) return nested;
    }
  }
  return "";
}

function resolveTargetObject(step: AuthScriptStep): Record<string, unknown> | null {
  if (step.target && typeof step.target === "object") {
    return step.target as Record<string, unknown>;
  }
  const payload = (step as { payload?: Record<string, unknown> }).payload;
  if (payload?.target && typeof payload.target === "object") {
    return payload.target as Record<string, unknown>;
  }
  return null;
}

function hasConfirmedOcr(target: Record<string, unknown> | null): boolean {
  if (!target) return false;
  const ocr = target.ocr;
  return Boolean(ocr && typeof ocr === "object");
}

function hasVisualAsset(target: Record<string, unknown> | null): boolean {
  if (!target) return false;
  return Boolean(target.asset || target.image || target.template || target.roi);
}

function matchToValue(target: Record<string, unknown> | null): string | null {
  if (!target) return null;
  const m = target.matchTo;
  return typeof m === "string" && m.trim() ? m.trim().toLowerCase() : null;
}

/**
 * True when Match-To requires visual ORC (top/middle/bottom) rather than DOM.
 * matchTo "none" / absent does not by itself force ORC if CSS exists.
 */
function matchToRequiresVisualOrc(matchTo: string | null): boolean {
  return matchTo === "top" || matchTo === "middle" || matchTo === "bottom";
}

export function classifyAuthStep(step: AuthScriptStep): AuthStepClassification {
  if (!step || typeof step !== "object") {
    return {
      kind: "unsupported",
      action: "",
      hasCssSelector: false,
      hasOcr: false,
      hasImageAsset: false,
      matchTo: null,
      reason: "step không hợp lệ",
    };
  }

  for (const forbidden of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(step, forbidden)) {
      return {
        kind: "unsupported",
        action: normalizeAuthAction(step.action),
        hasCssSelector: false,
        hasOcr: false,
        hasImageAsset: false,
        matchTo: null,
        reason: `forbidden field ${forbidden}`,
      };
    }
  }

  const payload = (step as { payload?: Record<string, unknown> }).payload;
  const actionRaw = step.action ?? payload?.action;
  const action = normalizeAuthAction(actionRaw);
  const target = resolveTargetObject(step);
  const hasCssSelector = Boolean(resolveDomSelector(step));
  const hasOcr = hasConfirmedOcr(target);
  const hasImageAsset = hasVisualAsset(target);
  const matchTo = matchToValue(target);

  if (!action) {
    return {
      kind: "unsupported",
      action: "",
      hasCssSelector,
      hasOcr,
      hasImageAsset,
      matchTo,
      reason: "thiếu action",
    };
  }

  // Explicit Creator visual actions that never map to DOM fill/click selectors.
  if (
    action === "click_and_type" ||
    action === "type_only" ||
    action === "wait_verify" ||
    action === "upload_file" ||
    action === "scroll"
  ) {
    return {
      kind: "orc_visual",
      action,
      hasCssSelector,
      hasOcr,
      hasImageAsset,
      matchTo,
      reason:
        "Script Creator ORC visual action — requires shared ORC runtime (not DOM Auth runner)",
    };
  }

  // CLICK_TARGET / click_target: DOM only when a real CSS selector is present.
  // Creator exports use asset/roi/ocr without CSS → ORC visual.
  if (action === "click_target" || action === "click") {
    if (hasCssSelector && !matchToRequiresVisualOrc(matchTo)) {
      return {
        kind: "dom",
        action,
        hasCssSelector,
        hasOcr,
        hasImageAsset,
        matchTo,
        reason: hasOcr
          ? "DOM selector present — OCR treated as metadata/fallback, not required for DOM path"
          : "DOM selector click",
      };
    }
    if (hasImageAsset || hasOcr || matchToRequiresVisualOrc(matchTo)) {
      return {
        kind: "orc_visual",
        action,
        hasCssSelector,
        hasOcr,
        hasImageAsset,
        matchTo,
        reason:
          "Visual target (asset/roi/OCR/Match-To) without DOM selector — ORC required; do not invent CSS from OCR",
      };
    }
  }

  // Standard DOM actions: allow even if target.ocr exists alongside CSS.
  if (DOM_ACTIONS.has(action)) {
    if (
      (action === "fill" || action === "type" || action === "type_text" || action === "submit") &&
      !hasCssSelector
    ) {
      if (hasImageAsset || hasOcr || matchToRequiresVisualOrc(matchTo)) {
        return {
          kind: "orc_visual",
          action,
          hasCssSelector,
          hasOcr,
          hasImageAsset,
          matchTo,
          reason: "No CSS selector; visual/OCR target present — ORC required",
        };
      }
      return {
        kind: "unsupported",
        action,
        hasCssSelector,
        hasOcr,
        hasImageAsset,
        matchTo,
        reason: `action ${action} cần CSS selector`,
      };
    }

    if (matchToRequiresVisualOrc(matchTo) && !hasCssSelector) {
      return {
        kind: "orc_visual",
        action,
        hasCssSelector,
        hasOcr,
        hasImageAsset,
        matchTo,
        reason: "Match-To top/middle/bottom without CSS — ORC required",
      };
    }

    return {
      kind: "dom",
      action,
      hasCssSelector,
      hasOcr,
      hasImageAsset,
      matchTo,
      reason: hasOcr
        ? "DOM action with CSS — OCR metadata ignored for DOM execution"
        : "DOM action",
    };
  }

  if (ORC_VISUAL_ACTIONS.has(action) || hasImageAsset || hasOcr) {
    return {
      kind: "orc_visual",
      action,
      hasCssSelector,
      hasOcr,
      hasImageAsset,
      matchTo,
      reason: "Requires Script Creator ORC runtime",
    };
  }

  return {
    kind: "unsupported",
    action,
    hasCssSelector,
    hasOcr,
    hasImageAsset,
    matchTo,
    reason: `action không hỗ trợ: ${action}`,
  };
}

/** Safe step fingerprint for logs — never includes OCR text / credentials. */
export function sanitizeStepMeta(step: AuthScriptStep, index: number): Record<string, unknown> {
  const c = classifyAuthStep(step);
  return {
    stepIndex: index,
    id: step.id ?? null,
    action: c.action,
    kind: c.kind,
    hasCssSelector: c.hasCssSelector,
    hasOcr: c.hasOcr,
    hasImageAsset: c.hasImageAsset,
    matchTo: c.matchTo,
    reason: c.reason,
  };
}
