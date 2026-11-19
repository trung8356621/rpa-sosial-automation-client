import type { AuthScriptStep } from "../auth/auth-script-types.js";
import type { Action, Payload, Rect, VisualTarget } from "./contracts.js";

const VISUAL_ACTIONS = new Set<string>([
  "click_target",
  "click_and_type",
  "upload_file",
  "quick_tag",
  "type_only",
  "wait_verify",
  "scroll",
  "sleep",
]);

function asAction(raw: unknown): Action | null {
  const a = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  if (
    a === "CLICK_TARGET" ||
    a === "CLICK_AND_TYPE" ||
    a === "UPLOAD_FILE" ||
    a === "QUICK_TAG" ||
    a === "TYPE_ONLY" ||
    a === "WAIT_VERIFY" ||
    a === "SCROLL" ||
    a === "SLEEP"
  ) {
    return a;
  }
  return null;
}

function asRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

/** Map Script Creator / Auth opaque step → Creator Payload (no CSS invention). */
export function authStepToVisualPayload(step: AuthScriptStep): Payload | null {
  const payloadNest =
    step.payload && typeof step.payload === "object"
      ? (step.payload as Record<string, unknown>)
      : null;
  const action = asAction(step.action ?? payloadNest?.action);
  if (!action) return null;
  if (!VISUAL_ACTIONS.has(action.toLowerCase())) return null;

  const targetRaw =
    (step.target && typeof step.target === "object" ? step.target : null) ||
    (payloadNest?.target && typeof payloadNest.target === "object"
      ? (payloadNest.target as Record<string, unknown>)
      : null);

  let target: VisualTarget | undefined;
  if (targetRaw) {
    const t = targetRaw as Record<string, unknown>;
    const asset = typeof t.asset === "string" ? t.asset : "";
    const roi = asRect(t.roi);
    if (asset && roi) {
      const ocrRaw = t.ocr && typeof t.ocr === "object" ? (t.ocr as Record<string, unknown>) : null;
      const ocrBbox = ocrRaw ? asRect(ocrRaw.bbox) : null;
      target = {
        asset,
        roi,
        matchTo:
          t.matchTo === "top" ||
          t.matchTo === "middle" ||
          t.matchTo === "bottom" ||
          t.matchTo === "none" ||
          t.matchTo === "current"
            ? t.matchTo
            : undefined,
        environment:
          t.environment && typeof t.environment === "object"
            ? {
                width: Number((t.environment as { width?: unknown }).width) || 0,
                height: Number((t.environment as { height?: unknown }).height) || 0,
                zoom: Number((t.environment as { zoom?: unknown }).zoom) || 1,
              }
            : undefined,
        clickOffset:
          t.clickOffset && typeof t.clickOffset === "object"
            ? {
                x: Number((t.clickOffset as { x?: unknown }).x) || 0,
                y: Number((t.clickOffset as { y?: unknown }).y) || 0,
              }
            : undefined,
        ocr:
          ocrRaw && ocrRaw.confirmed === true && ocrBbox
            ? {
                confirmed: true,
                language: "vie+eng",
                text: String(ocrRaw.text ?? ""),
                confidence: Number(ocrRaw.confidence) || 0,
                kind:
                  ocrRaw.kind === "word" || ocrRaw.kind === "block" || ocrRaw.kind === "line"
                    ? ocrRaw.kind
                    : "line",
                bbox: ocrBbox,
              }
            : undefined,
      };
      if (target.environment && (target.environment.width < 1 || target.environment.height < 1)) {
        target.environment = undefined;
      }
    }
  }

  return {
    action,
    target,
    text: typeof step.value === "string" ? step.value : typeof payloadNest?.text === "string" ? payloadNest.text : undefined,
    inputMethod:
      step.inputMethod === "clipboard" || payloadNest?.inputMethod === "clipboard"
        ? "clipboard"
        : "keyboard",
    timeoutMs: Number(step.timeoutMs ?? step.timeout_ms ?? payloadNest?.timeoutMs) || undefined,
    threshold: Number(step.threshold ?? payloadNest?.threshold) || undefined,
    deltaY: Number(step.deltaY ?? payloadNest?.deltaY) || undefined,
    sleepMs: Number(step.sleepMs ?? step.ms ?? payloadNest?.sleepMs) || undefined,
    method:
      step.method === "image" || step.method === "ocr" || step.method === "auto"
        ? step.method
        : payloadNest?.method === "image" ||
            payloadNest?.method === "ocr" ||
            payloadNest?.method === "auto"
          ? (payloadNest.method as "auto" | "image" | "ocr")
          : "auto",
  };
}
