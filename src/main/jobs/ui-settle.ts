/**
 * Bounded post-action UI settle for terminal success screenshots.
 *
 * Reuses the double-rAF paint settle pattern from EmbeddedBrowser navigation idle,
 * then applies a fixed SPA visual delay. Does not wait for navigation events.
 * Hard-capped so occluded/throttled WebContentsViews cannot hang.
 */

export const POST_ACTION_UI_SETTLE_MS = 1_200;
export const UI_SETTLE_RAF_INNER_CAP_MS = 300;
export const UI_SETTLE_HARD_CAP_MS = 1_500;

/** Double-rAF with an in-page timeout so hidden/occluded views do not stall forever. */
export const DOUBLE_RAF_SETTLE_SCRIPT =
  "new Promise((r) => { const t = setTimeout(r, 300); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); })";

export type UiSettleWebContents = {
  isDestroyed?: () => boolean;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

export type UiSettleResult = {
  waitedMs: number;
  reason: "settled" | "unavailable" | "hard_cap";
};

export async function waitForBoundedUiSettle(params: {
  webContents?: UiSettleWebContents | null;
  /** Target post-action settle budget (SPA visual update). Default 1200ms. */
  settleMs?: number;
  /** Absolute hard cap. Default 1500ms. */
  hardCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<UiSettleResult> {
  const settleMs = Math.max(0, params.settleMs ?? POST_ACTION_UI_SETTLE_MS);
  const hardCapMs = Math.max(settleMs, params.hardCapMs ?? UI_SETTLE_HARD_CAP_MS);
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = params.now ?? Date.now;
  const started = now();
  const wc = params.webContents;

  if (!wc || wc.isDestroyed?.()) {
    return { waitedMs: 0, reason: "unavailable" };
  }

  // 1) Prefer existing paint settle (double-rAF), bounded — no navigation wait.
  if (typeof wc.executeJavaScript === "function") {
    const rafBudget = Math.min(UI_SETTLE_RAF_INNER_CAP_MS, remaining(started, hardCapMs, now));
    if (rafBudget > 0) {
      try {
        await Promise.race([wc.executeJavaScript(DOUBLE_RAF_SETTLE_SCRIPT, true), sleep(rafBudget)]);
      } catch {
        /* ignore paint settle failures; still apply fixed delay below */
      }
    }
  }

  // 2) Remaining fixed delay for SPA visual updates after the final action.
  const elapsed = now() - started;
  if (elapsed >= hardCapMs) {
    return { waitedMs: elapsed, reason: "hard_cap" };
  }
  const remainingSettle = Math.max(0, Math.min(settleMs - elapsed, hardCapMs - elapsed));
  if (remainingSettle > 0) {
    await sleep(remainingSettle);
  }

  const waitedMs = now() - started;
  return {
    waitedMs,
    reason: waitedMs >= hardCapMs ? "hard_cap" : "settled",
  };
}

function remaining(started: number, hardCapMs: number, now: () => number): number {
  return Math.max(0, hardCapMs - (now() - started));
}
