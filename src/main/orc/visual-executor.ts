import type { WebContents } from "electron";
import sharp from "sharp";
import type { Payload, Rect, ResolutionTrace, VisualEnvironment } from "./contracts.js";
import { OrcBrowserHost } from "./browser-host.js";
import {
  checkWordPressRememberMeCheckbox,
  inspectWordPressRememberMeContext,
  resolveCheckboxTargetKind,
  type CheckboxInspectResult,
  type CheckboxState,
} from "./checkbox-state.js";
import { effectiveMatchTo } from "./match-to.js";
import { advanceOcrSearch, clearOcrSearch } from "./ocr-match-scroll.js";
import { localOcr, type OcrEngine } from "./ocr.js";
import {
  MIN_OCR_CONFIDENCE,
  normalizeTargetText,
  OcrNotFound,
  OcrTechnicalError,
  resolveVisualTarget,
  TargetNotConfident,
} from "./target-resolver.js";
import { logClientEvent, logClientError } from "../main-error-log.js";

export type VisualStepOutcome =
  | { kind: "ok"; action: string; x?: number; y?: number; method?: string }
  | {
      kind: "blocked";
      message: string;
      code: string;
      confirmedNotFound?: boolean;
      mutated?: boolean;
    }
  | { kind: "error"; message: string; mutated?: boolean };

function classifyTargetNotConfident(
  err: TargetNotConfident,
  confirmedNotFound: boolean
): { code: string; matchResult: string } {
  if (confirmedNotFound) {
    return { code: "NOT_FOUND", matchResult: "not_confident" };
  }
  if (err.message.startsWith("SCROLL_CONTAINER_CHANGED:")) {
    return { code: "SCROLL_CONTAINER_CHANGED", matchResult: "scroll_container_changed" };
  }
  if (err.message.startsWith("SCAN_RESET_FAILED:")) {
    return { code: "SCAN_RESET_FAILED", matchResult: "scan_reset_failed" };
  }
  return { code: "TARGET_NOT_CONFIDENT", matchResult: "not_confident" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared Visual ORC step executor (Creator semantics) for Client Browser sessions.
 * Ports the resolve→click/type loop from Admin Runtime without Store/BrowserCore.
 * Baseline: 8c06ef86179d7f90c21bdba81bf6a768227e148e
 */
export class VisualOrcExecutor {
  constructor(
    private readonly host: OrcBrowserHost,
    private readonly ocr: OcrEngine = localOcr
  ) {}

  static fromWebContents(webContents: WebContents, bounds: Rect): VisualOrcExecutor {
    return new VisualOrcExecutor(new OrcBrowserHost(webContents, bounds));
  }

  setBounds(bounds: Rect): void {
    this.host.bounds = { ...bounds };
  }

  /**
   * Align zoom to Creator target.environment when present.
   * Viewport DIP size must already match environment.width×height (caller responsibility).
   */
  async prepareEnvironment(env: VisualEnvironment | undefined): Promise<void> {
    if (!env) return;
    if (![1, 0.9, 0.8].includes(env.zoom)) {
      throw new Error(`Zoom không hỗ trợ: ${env.zoom}`);
    }
    await this.host.setZoom(env.zoom);
  }

  assertViewport(env: VisualEnvironment | undefined, capture: { width: number; height: number }): void {
    if (!env) return;
    if (env.width !== this.host.bounds.width || env.height !== this.host.bounds.height) {
      throw new Error(
        `Viewport DIP không khớp target: cần ${env.width}×${env.height}, view ${this.host.bounds.width}×${this.host.bounds.height}. Không scale.`
      );
    }
    if (capture.width !== env.width || capture.height !== env.height) {
      throw new Error(
        `Screenshot viewport mismatch: expected ${env.width}×${env.height}, got ${capture.width}×${capture.height}. Không scale ảnh hoặc tọa độ.`
      );
    }
    if (Math.abs(this.host.zoom - env.zoom) > 0.001) {
      throw new Error(
        `Zoom không khớp target: cần ${env.zoom}, hiện tại ${this.host.zoom}.`
      );
    }
  }

  async executeVisualStep(params: {
    payload: Payload;
    template: Buffer;
    text?: string;
    stepId?: string;
    stepName?: string;
    authorizedSiteUrl?: string | null;
    inspectCheckboxState?: () => Promise<CheckboxState | CheckboxInspectResult>;
    checkCheckbox?: () => Promise<boolean>;
    signal?: AbortSignal;
    onPhase?: (phase: "ocr" | "click" | "type") => void;
  }): Promise<VisualStepOutcome> {
    const { payload, template, text, stepId, stepName, authorizedSiteUrl, signal, onPhase } = params;
    const action = payload.action;

    if (action === "TYPE_ONLY") {
      if (!text) return { kind: "error", message: "TYPE_ONLY thiếu text" };
      onPhase?.("type");
      await this.host.typeText(text);
      return { kind: "ok", action };
    }
    if (action === "SCROLL") {
      this.host.scroll(Number(payload.deltaY ?? 0));
      return { kind: "ok", action };
    }
    if (action === "SLEEP") {
      await sleep(Number(payload.sleepMs ?? 0));
      return { kind: "ok", action };
    }
    if (!payload.target?.asset) {
      return { kind: "error", message: `${action} thiếu target.asset` };
    }

    let capturedWidth: number | null = null;
    let capturedHeight: number | null = null;
    let templateWidth: number | null = null;
    let templateHeight: number | null = null;
    let candidateCount = 0;
    let bestOcrConfidence: number | null = null;
    const requiredOcrConfidence = payload.target.ocr?.confirmed ? MIN_OCR_CONFIDENCE : null;
    let templateMatchConfidence: number | null = null;
    let selectedMatchingMethod: string | null = null;
    let checkboxStateBefore: CheckboxState | null = null;
    let checkboxStateAfter: CheckboxState | null = null;
    let executionMethod: "verified_dom" | "visual_orc" = "visual_orc";
    let visualFallbackReason: string | null = null;
    let lastTrace: ResolutionTrace | undefined;

    const recordTrace = (trace?: ResolutionTrace) => {
      if (!trace) return;
      lastTrace = trace;
      for (const att of trace.attempts) {
        if (att.method === "ocr" && typeof att.confidence === "number") {
          bestOcrConfidence =
            bestOcrConfidence == null ? att.confidence : Math.max(bestOcrConfidence, att.confidence);
        }
        if (att.method === "image" && typeof att.score === "number") {
          templateMatchConfidence =
            templateMatchConfidence == null
              ? att.score
              : Math.max(templateMatchConfidence, att.score);
        }
      }
      if (trace.selectedMethod) selectedMatchingMethod = trace.selectedMethod;
    };

    const checkboxKind = resolveCheckboxTargetKind({
      action,
      stepName,
      ocrText: payload.target.ocr?.text,
    });
    const checkboxTargetDetected = checkboxKind === "wordpress_remember_me";

    const emitDiagnostic = (
      matchResult: string,
      matchReason: string,
      failureReason: string | null = null,
      finalStepOutcome: "ok" | "blocked" | "error" = matchResult === "matched" || matchResult === "already_checked" ? "ok" : "error"
    ) => {
      recordTrace(lastTrace);
      logClientEvent("ORC_STEP_DIAGNOSTIC", {
        stepId: stepId ?? null,
        action,
        currentUrl: typeof this.host.getSanitizedUrl === "function" ? this.host.getSanitizedUrl() : "",
        viewportWidth: this.host.bounds.width,
        viewportHeight: this.host.bounds.height,
        capturedWidth,
        capturedHeight,
        deviceScaleFactor: this.host.deviceScaleFactor ?? 1,
        zoomFactor: this.host.zoom,
        templateWidth,
        templateHeight,
        candidateCount,
        bestOcrConfidence,
        requiredOcrConfidence,
        templateMatchConfidence,
        selectedMatchingMethod,
        checkboxTargetDetected,
        checkboxStateBefore,
        checkboxStateAfter,
        executionMethod,
        visualFallbackReason,
        matchResult,
        matchReason,
        failureReason,
        finalStepOutcome,
      });
    };

    const inspectCheckbox = checkboxTargetDetected
      ? async (): Promise<CheckboxInspectResult> => {
          if (params.inspectCheckboxState) {
            const raw = await params.inspectCheckboxState();
            return typeof raw === "string"
              ? { state: raw, reason: raw === "unavailable" ? "unavailable" : "ok" }
              : raw;
          }
          return inspectWordPressRememberMeContext(this.host.webContents, authorizedSiteUrl);
        }
      : null;

    const toggleCheckbox = checkboxTargetDetected
      ? (params.checkCheckbox ??
        (() => checkWordPressRememberMeCheckbox(this.host.webContents, authorizedSiteUrl)))
      : null;

    let mutated = false;

    try {
      if (inspectCheckbox) {
        const beforeCtx = await inspectCheckbox();
        checkboxStateBefore = beforeCtx.state;
        if (checkboxStateBefore === "checked") {
          executionMethod = "verified_dom";
          checkboxStateAfter = "checked";
          selectedMatchingMethod = "verified_dom";
          emitDiagnostic("already_checked", "checkbox_already_checked", null, "ok");
          return { kind: "ok", action, method: "verified_dom" };
        }
        if (checkboxStateBefore === "unchecked" && toggleCheckbox) {
          executionMethod = "verified_dom";
          selectedMatchingMethod = "verified_dom";
          await toggleCheckbox();
          await sleep(80);
          const afterCtx = await inspectCheckbox();
          checkboxStateAfter = afterCtx.state;
          if (checkboxStateAfter !== "checked") {
            emitDiagnostic(
              "checkbox_verify_failed",
              "verified_dom_toggle_failed",
              `CHECKBOX_VERIFY_FAILED:${checkboxStateAfter}`,
              "error"
            );
            return {
              kind: "error",
              message: `CHECKBOX_VERIFY_FAILED: Remember Me chưa ở trạng thái checked (${checkboxStateAfter}).`,
            };
          }
          emitDiagnostic("matched", "verified_dom", null, "ok");
          return { kind: "ok", action, method: "verified_dom" };
        }
        // No trustworthy DOM checkbox exists (absent / ambiguous / form_mismatch / unavailable):
        // retain strict Visual ORC OCR/template matching.
        executionMethod = "visual_orc";
        visualFallbackReason =
          beforeCtx.reason !== "ok" ? `dom_${beforeCtx.reason}` : "dom_unavailable";
      }

      const tplMeta = await sharp(template).metadata().catch(() => null);
      templateWidth = tplMeta?.width ?? null;
      templateHeight = tplMeta?.height ?? null;

      await this.prepareEnvironment(payload.target.environment);
      const before = await this.host.capture({ light: true });
      capturedWidth = before.width;
      capturedHeight = before.height;
      this.assertViewport(payload.target.environment, before);

      const mode = effectiveMatchTo(payload);
      const matchTo = mode === "none" ? undefined : mode;
      const deadline =
        Date.now() +
        (matchTo
          ? 120_000
          : action === "WAIT_VERIFY"
            ? (payload.timeoutMs ?? 3000)
            : 15_000);

      let scrolls = 0;
      let searchRegion: Rect | undefined;
      let current = before;
      let match: { x: number; y: number; method?: string; score: number } | undefined;

      if (matchTo) await clearOcrSearch(this.host.webContents);

      try {
        if (matchTo) {
          if (matchTo === "top") {
            const reset = await advanceOcrSearch(
              this.host.webContents,
              matchTo,
              this.host.zoom,
              true,
              false
            );
            if (reset.moved) {
              mutated = true;
              await sleep(120);
              current = await this.host.capture({ light: true });
            }
          }
          const scope = await advanceOcrSearch(
            this.host.webContents,
            matchTo,
            this.host.zoom,
            false,
            true
          );
          searchRegion = scope.searchRegion;
        }

        do {
          if (signal?.aborted) {
            return { kind: "blocked", code: "CANCELLED", message: "ORC bị hủy." };
          }
          if (Date.now() > deadline) {
            return {
              kind: "blocked",
              code: "TIME_LIMIT",
              message: "ORC hết thời gian tìm target.",
            };
          }

          try {
            if (matchTo) {
              const scope = await advanceOcrSearch(
                this.host.webContents,
                matchTo,
                this.host.zoom,
                false,
                true
              );
              searchRegion = scope.searchRegion;
            }

            const resolved = await resolveVisualTarget(
              this.host.captureBuffer(current.id),
              template,
              payload,
              this.ocr,
              searchRegion,
              (event) => {
                if (event.phase === "start") {
                  onPhase?.("ocr");
                  logClientEvent("ORC_OCR_START", {
                    expectedKind: payload.target?.ocr?.kind,
                    hasExpectedText: Boolean(payload.target?.ocr?.text),
                    normalizedExpectedLen: normalizeTargetText(
                      payload.target?.ocr?.text ?? ""
                    ).length,
                  });
                } else if (event.phase === "result" && event.result) {
                  candidateCount = event.result.segments.length;
                }
              },
              (imgEvent) => {
                candidateCount = Math.max(candidateCount, imgEvent.positions);
              }
            );
            recordTrace(resolved.resolution);
            match = {
              x: resolved.x,
              y: resolved.y,
              method: resolved.method,
              score: resolved.score,
            };
            selectedMatchingMethod = resolved.method ?? selectedMatchingMethod;
            break;
          } catch (error) {
            if (error instanceof TargetNotConfident) recordTrace(error.resolution);
            if (error instanceof OcrTechnicalError) throw error;
            if (!matchTo || !(error instanceof OcrNotFound)) {
              if (error instanceof TargetNotConfident) {
                const confirmedNotFound =
                  !mutated &&
                  !error.ambiguous &&
                  ((error instanceof OcrNotFound && error.outcome === "NOT_FOUND") ||
                    error.resolution?.ocrOutcome === "NOT_FOUND");
                const { code, matchResult } = classifyTargetNotConfident(error, confirmedNotFound);
                emitDiagnostic(matchResult, error.message, error.message, "blocked");
                return {
                  kind: "blocked",
                  code,
                  message: error.message,
                  confirmedNotFound,
                  mutated,
                };
              }
              throw error;
            }
            if (scrolls >= 40) {
              emitDiagnostic("scroll_limit", error.message, error.message);
              return {
                kind: "blocked",
                code: "SCROLL_LIMIT",
                message: error.message,
                confirmedNotFound: false,
                mutated: true,
              };
            }
            const progress = await advanceOcrSearch(
              this.host.webContents,
              matchTo,
              this.host.zoom
            );
            if (!progress.moved) {
              emitDiagnostic(progress.reason ?? "scroll_stalled", error.message, error.message);
              return {
                kind: "blocked",
                code: progress.reason ?? "SCROLL_STALLED",
                message: error.message,
                confirmedNotFound: false,
                mutated,
              };
            }
            mutated = true;
            scrolls += 1;
            await sleep(250);
            current = await this.host.capture({ light: true });
          }
        } while (true);
      } finally {
        if (matchTo) await clearOcrSearch(this.host.webContents);
      }

      if (!match) {
        emitDiagnostic("not_found", "no_match", "NOT_FOUND");
        return {
          kind: "blocked",
          code: "NOT_FOUND",
          message: "Không resolve được target.",
          confirmedNotFound: !mutated,
          mutated,
        };
      }

      if (action === "WAIT_VERIFY") {
        emitDiagnostic("matched", match.method ?? "ok");
        return { kind: "ok", action, x: match.x, y: match.y, method: match.method };
      }

      mutated = true;
      onPhase?.("click");
      this.host.click(match.x, match.y, current.width, current.height);
      logClientEvent("ORC_CLICK", {
        action,
        method: match.method,
        // never log OCR text / credentials
        hasTextPayload: Boolean(text),
      });

      if (inspectCheckbox) {
        await sleep(80);
        const afterCtx = await inspectCheckbox();
        checkboxStateAfter = afterCtx.state;
        if (checkboxStateAfter !== "checked") {
          emitDiagnostic(
            "checkbox_verify_failed",
            match.method ?? "ok",
            `CHECKBOX_VERIFY_FAILED:${checkboxStateAfter}`,
            "error"
          );
          return {
            kind: "error",
            message: `CHECKBOX_VERIFY_FAILED: đã click Remember Me nhưng trạng thái sau click là ${checkboxStateAfter}.`,
          };
        }
      }

      emitDiagnostic("matched", match.method ?? "ok", null, "ok");

      if (action === "CLICK_AND_TYPE") {
        await sleep(80);
        if (!text) {
          return { kind: "error", message: "CLICK_AND_TYPE thiếu text/variable binding" };
        }
        onPhase?.("type");
        await this.host.typeText(text);
      }

      return { kind: "ok", action, x: match.x, y: match.y, method: match.method };
    } catch (err) {
      if (err instanceof TargetNotConfident) {
        const { code, matchResult } = classifyTargetNotConfident(err, false);
        emitDiagnostic(matchResult, err.message, err.message, "blocked");
        return {
          kind: "blocked",
          code,
          message: err.message,
          confirmedNotFound: false,
          mutated,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      emitDiagnostic(
        /Viewport|Screenshot viewport|Zoom/.test(message) ? "viewport_mismatch" : "error",
        message,
        message
      );
      logClientError("ORC visual step failed", { action, error: message });
      if (/Viewport|Screenshot viewport|Zoom/.test(message)) {
        return { kind: "blocked", code: "VIEWPORT_MISMATCH", message };
      }
      return { kind: "error", message };
    }
  }
}
