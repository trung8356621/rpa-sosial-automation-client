import { WebContentsView, ipcMain, type BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logClientError, logClientEvent } from "../main-error-log.js";

export type InteractionLockMode = "off" | "locked" | "human";

export type InteractionLockState = {
  mode: InteractionLockMode;
  message: string | null;
  reason: string | null;
};

const CHANNEL_STOP = "rpa-automation-lock-stop";
const CHANNEL_RESUME = "rpa-automation-lock-resume";

let ipcRegistered = false;

export function resolveAutomationLockPreloadPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "preload", "automation-lock-preload.cjs");
}

/**
 * Native overlay above the embedded Browser WebContentsView.
 * Blocks user pointer/keyboard to the Browser without changing viewport/zoom/session.
 * ORC continues via executeJavaScript / loadURL on the underlying WebContents.
 */
export class BrowserInteractionLock {
  private overlay: WebContentsView | null = null;
  private mode: InteractionLockMode = "off";
  private message: string | null = null;
  private reason: string | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private stopHandler: (() => void) | null = null;
  private resumeHandler: (() => void) | null = null;
  private stateListeners = new Set<(state: InteractionLockState) => void>();

  constructor(private readonly window: BrowserWindow) {
    this.ensureIpc();
  }

  onStateChange(listener: (state: InteractionLockState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  getState(): InteractionLockState {
    return { mode: this.mode, message: this.message, reason: this.reason };
  }

  isLocked(): boolean {
    return this.mode === "locked";
  }

  isHumanUnlock(): boolean {
    return this.mode === "human";
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
    if (this.overlay) {
      this.overlay.setBounds(bounds);
    }
  }

  /**
   * Show blocking overlay over the Browser region.
   * Does not recreate or resize the Browser WebContentsView.
   */
  async lock(params: {
    message?: string;
    reason?: string;
    onStop?: () => void;
  }): Promise<void> {
    this.stopHandler = params.onStop ?? null;
    this.resumeHandler = null;
    this.message =
      params.message ?? "Automation đang chạy — Vui lòng không thao tác";
    this.reason = params.reason ?? "automation";
    this.mode = "locked";
    await this.ensureOverlay();
    await this.renderOverlay();
    this.notify();
    logClientEvent("BROWSER_INTERACTION_LOCKED", {
      reason: this.reason,
      mode: this.mode,
    });
  }

  /**
   * Temporarily unlock for CAPTCHA / HUMAN_REQUIRED verification.
   * Overlay remains visible with Resume CTA but pointer events pass? No —
   * hide overlay so user can interact with Browser; show status via state.
   */
  async unlockForHuman(params: {
    message?: string;
    reason?: string;
    onResume?: () => void;
  }): Promise<void> {
    this.resumeHandler = params.onResume ?? null;
    this.stopHandler = null;
    this.message =
      params.message ??
      "Cần xác minh thủ công (CAPTCHA/checkpoint) — xử lý xong rồi bấm Tiếp tục";
    this.reason = params.reason ?? "HUMAN_REQUIRED";
    this.mode = "human";
    this.removeOverlayView();
    this.notify();
    logClientEvent("BROWSER_INTERACTION_HUMAN_UNLOCK", {
      reason: this.reason,
    });
  }

  /** Re-lock after human confirms continue. */
  async relockAfterHuman(params?: {
    message?: string;
    reason?: string;
    onStop?: () => void;
  }): Promise<void> {
    await this.lock({
      message: params?.message,
      reason: params?.reason ?? "resume_after_human",
      onStop: params?.onStop,
    });
  }

  /** Always clear overlay and restore user interaction. */
  async release(reason = "complete"): Promise<void> {
    this.mode = "off";
    this.message = null;
    this.reason = null;
    this.stopHandler = null;
    this.resumeHandler = null;
    this.removeOverlayView();
    this.notify();
    logClientEvent("BROWSER_INTERACTION_UNLOCKED", { reason });
  }

  dispose(): void {
    void this.release("dispose");
  }

  private ensureIpc(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle(CHANNEL_STOP, (event) => {
      // Only accept from our overlay webContents
      if (this.overlay && event.sender === this.overlay.webContents) {
        const fn = this.stopHandler;
        logClientEvent("BROWSER_INTERACTION_STOP_REQUESTED", {});
        if (fn) fn();
        return { ok: true };
      }
      return { ok: false };
    });

    ipcMain.handle(CHANNEL_RESUME, (_event) => {
      // Resume can come from renderer UI as well (main command path preferred).
      const fn = this.resumeHandler;
      logClientEvent("BROWSER_INTERACTION_RESUME_REQUESTED", {});
      if (fn) fn();
      return { ok: true };
    });
  }

  /** Public resume trigger from ClientCommand (renderer Confirm button). */
  requestResumeFromUi(): void {
    const fn = this.resumeHandler;
    if (fn) fn();
  }

  requestStopFromUi(): void {
    const fn = this.stopHandler;
    if (fn) fn();
  }

  private async ensureOverlay(): Promise<void> {
    if (this.overlay) {
      this.overlay.setBounds(this.bounds);
      this.overlay.setVisible(true);
      // Keep overlay above browser by re-adding as last child
      try {
        this.window.contentView.removeChildView(this.overlay);
      } catch {
        // not attached
      }
      this.window.contentView.addChildView(this.overlay);
      return;
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: resolveAutomationLockPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.overlay = view;
    view.setBounds(this.bounds);
    view.setVisible(true);
    this.window.contentView.addChildView(view);

    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("before-input-event", (event, input) => {
      // Block shortcuts from reaching Browser; allow Tab within overlay for a11y Stop button.
      if (input.type === "keyDown" && input.key !== "Tab" && input.key !== "Enter" && input.key !== " ") {
        // Stop button uses click; block other keys from falling through conceptually.
        // Overlay has focus while locked so Browser does not receive these.
      }
      // Never prevent default for system-level handling — Electron cannot block OS hotkeys.
      void event;
    });
  }

  private async renderOverlay(): Promise<void> {
    if (!this.overlay) return;
    const msg = JSON.stringify(
      this.message ?? "Automation đang chạy — Vui lòng không thao tác"
    );
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;width:100%;font-family:Segoe UI,sans-serif;background:rgba(15,23,42,.72);color:#f8fafc;user-select:none;-webkit-user-select:none;}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;box-sizing:border-box;text-align:center;}
  .msg{font-size:15px;font-weight:600;max-width:420px;line-height:1.4;}
  button{cursor:pointer;border:0;border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;background:#ef4444;color:#fff;}
  button:hover{background:#dc2626;}
  button:focus{outline:2px solid #fca5a5;outline-offset:2px;}
</style></head>
<body>
  <div class="wrap">
    <div class="msg" id="msg"></div>
    <button type="button" id="stop">Dừng automation</button>
  </div>
  <script>
    document.getElementById('msg').textContent = ${msg};
    document.getElementById('stop').addEventListener('click', function () {
      if (window.__rpaAutomationLock && window.__rpaAutomationLock.stop) {
        window.__rpaAutomationLock.stop();
      }
    });
    // Capture wheel/drag so nothing reaches views below (overlay is topmost native view).
    window.addEventListener('wheel', function(e){ e.preventDefault(); }, { passive: false });
    window.addEventListener('dragstart', function(e){ e.preventDefault(); });
  </script>
</body></html>`;
    try {
      await this.overlay.webContents.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
      );
    } catch (err) {
      logClientError("Failed to render automation lock overlay", err);
    }
  }

  private removeOverlayView(): void {
    if (!this.overlay) return;
    try {
      this.window.contentView.removeChildView(this.overlay);
      this.overlay.webContents.close({ waitForBeforeUnload: false });
    } catch (err) {
      logClientError("Error removing automation lock overlay", err);
    }
    this.overlay = null;
  }

  private notify(): void {
    const state = this.getState();
    for (const l of this.stateListeners) {
      try {
        l(state);
      } catch {
        // ignore
      }
    }
  }
}
