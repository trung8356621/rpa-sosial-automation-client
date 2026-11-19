import type { WebContents } from "electron";
import type { Payload, Rect, VisualEnvironment } from "./contracts.js";
import { OrcBrowserHost } from "./browser-host.js";
import { effectiveMatchTo } from "./match-to.js";
import { advanceOcrSearch, clearOcrSearch } from "./ocr-match-scroll.js";
import { localOcr, type OcrEngine } from "./ocr.js";
import {
  normalizeTargetText,
  OcrNotFound,
  OcrTechnicalError,
  resolveVisualTarget,
  TargetNotConfident,
} from "./target-resolver.js";
import { logClientEvent, logClientError } from "../main-error-log.js";

export type VisualStepOutcome =
  | { kind: "ok"; action: string; x?: number; y?: number; method?: string }
  | { kind: "blocked"; message: string; code: string }
  | { kind: "error"; message: string };

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
    signal?: AbortSignal;
  }): Promise<VisualStepOutcome> {
    const { payload, template, text, signal } = params;
    const action = payload.action;

    if (action === "TYPE_ONLY") {
      if (!text) return { kind: "error", message: "TYPE_ONLY thiếu text" };
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

    try {
      await this.prepareEnvironment(payload.target.environment);
      const before = await this.host.capture({ light: true });
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
                  logClientEvent("ORC_OCR_START", {
                    expectedKind: payload.target?.ocr?.kind,
                    hasExpectedText: Boolean(payload.target?.ocr?.text),
                    normalizedExpectedLen: normalizeTargetText(
                      payload.target?.ocr?.text ?? ""
                    ).length,
                  });
                }
              }
            );
            match = {
              x: resolved.x,
              y: resolved.y,
              method: resolved.method,
              score: resolved.score,
            };
            break;
          } catch (error) {
            if (error instanceof OcrTechnicalError) throw error;
            if (!matchTo || !(error instanceof OcrNotFound)) {
              if (error instanceof TargetNotConfident) {
                return {
                  kind: "blocked",
                  code: "TARGET_NOT_CONFIDENT",
                  message: error.message,
                };
              }
              throw error;
            }
            if (scrolls >= 40) {
              return {
                kind: "blocked",
                code: "SCROLL_LIMIT",
                message: error.message,
              };
            }
            const progress = await advanceOcrSearch(
              this.host.webContents,
              matchTo,
              this.host.zoom
            );
            if (!progress.moved) {
              return {
                kind: "blocked",
                code: progress.reason ?? "SCROLL_STALLED",
                message: error.message,
              };
            }
            scrolls += 1;
            await sleep(250);
            current = await this.host.capture({ light: true });
          }
        } while (true);
      } finally {
        if (matchTo) await clearOcrSearch(this.host.webContents);
      }

      if (!match) {
        return { kind: "blocked", code: "NOT_FOUND", message: "Không resolve được target." };
      }

      if (action === "WAIT_VERIFY") {
        return { kind: "ok", action, x: match.x, y: match.y, method: match.method };
      }

      this.host.click(match.x, match.y, current.width, current.height);
      logClientEvent("ORC_CLICK", {
        action,
        method: match.method,
        // never log OCR text / credentials
        hasTextPayload: Boolean(text),
      });

      if (action === "CLICK_AND_TYPE") {
        await sleep(80);
        if (!text) {
          return { kind: "error", message: "CLICK_AND_TYPE thiếu text/variable binding" };
        }
        await this.host.typeText(text);
      }

      return { kind: "ok", action, x: match.x, y: match.y, method: match.method };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logClientError("ORC visual step failed", { action, error: message });
      if (/Viewport|Screenshot viewport|Zoom/.test(message)) {
        return { kind: "blocked", code: "VIEWPORT_MISMATCH", message };
      }
      return { kind: "error", message };
    }
  }
}
