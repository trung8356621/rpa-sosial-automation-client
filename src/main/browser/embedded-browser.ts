import { WebContentsView, session, type BrowserWindow } from "electron";
import type { BrowserProfile, BrowserViewState, SessionSignal } from "../../shared/contracts.js";
import type { ProfileManager } from "./profile-manager.js";
import type { BrowserSyncService } from "./browser-sync-service.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export class EmbeddedBrowser {
  private view: WebContentsView | null = null;
  private activeBrowserId: string | null = null;
  private currentUrl = "";
  private isLoading = false;
  private visible = false;
  private bounds = { x: 260, y: 120, width: 680, height: 560 };
  private stateListeners = new Set<(state: BrowserViewState) => void>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly profileManager: ProfileManager,
    private readonly syncService: BrowserSyncService
  ) {}

  onViewStateChange(listener: (state: BrowserViewState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getViewState());
    return () => this.stateListeners.delete(listener);
  }

  private notify(): void {
    const s = this.getViewState();
    for (const l of this.stateListeners) {
      try {
        l(s);
      } catch {
        // ignore
      }
    }
  }

  getViewState(): BrowserViewState {
    const wc = this.view?.webContents;
    return {
      activeBrowserId: this.activeBrowserId,
      currentUrl: this.currentUrl,
      isLoading: this.isLoading,
      canGoBack: Boolean(wc?.navigationHistory?.canGoBack ? wc.navigationHistory.canGoBack() : wc?.canGoBack()),
      canGoForward: Boolean(wc?.navigationHistory?.canGoForward ? wc.navigationHistory.canGoForward() : wc?.canGoForward()),
      visible: this.visible,
    };
  }

  getWebContents() {
    return this.view?.webContents;
  }

  getActiveBrowserId(): string | null {
    return this.activeBrowserId;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
    if (this.view) {
      this.view.setBounds(bounds);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.view) {
      this.view.setVisible(visible);
    }
    this.notify();
  }

  async open(browserId: string, initialUrl?: string): Promise<void> {
    const profile = this.profileManager.get(browserId);
    if (!profile) {
      throw new Error(`Profile ${browserId} không tồn tại.`);
    }

    // Single active browser constraint: Close current if open
    if (this.view && this.activeBrowserId !== browserId) {
      await this.stop();
    }

    if (this.view && this.activeBrowserId === browserId) {
      // Already running
      if (initialUrl) {
        await this.navigate(initialUrl);
      }
      this.setVisible(true);
      return;
    }

    logClientEvent("Starting embedded browser view", {
      browserId,
      name: profile.name,
      partition: profile.partition,
    });

    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    this.view = view;
    this.activeBrowserId = browserId;
    await this.profileManager.setStatus(browserId, "running");

    const wc = view.webContents;

    // Window open & navigation safety
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) {
        void this.navigate(url).catch(() => {});
      }
      return { action: "deny" };
    });

    wc.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//.test(url)) {
        event.preventDefault();
      }
    });

    wc.on("did-start-loading", () => {
      this.isLoading = true;
      this.notify();
    });

    wc.on("did-stop-loading", () => {
      this.isLoading = false;
      this.notify();
    });

    const updateUrl = (url: string) => {
      if (/^https?:\/\//.test(url)) {
        this.currentUrl = url;
        void this.profileManager.recordUrl(browserId, url);
        if (url.includes("facebook.com")) {
          void this.checkSessionSignal(browserId);
        }
        this.notify();
      }
    };

    wc.on("did-navigate", (_event, url) => updateUrl(url));
    wc.on("did-navigate-in-page", (_event, url) => updateUrl(url));

    // Mount to window contentView
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    this.setVisible(true);

    // Initial navigation
    const targetUrl = initialUrl || profile.lastUrl || "https://www.facebook.com";
    await this.navigate(targetUrl).catch((err) => {
      logClientError("Initial browser navigation failed", err);
    });

    // Check session signal on browser open
    void this.checkSessionSignal(browserId);

    // Sync status change to SEO-OPS
    void this.syncService.syncAll();
  }

  async stop(): Promise<void> {
    if (!this.view) {
      if (this.activeBrowserId) {
        await this.profileManager.setStatus(this.activeBrowserId, "stopped");
        this.activeBrowserId = null;
        this.notify();
        void this.syncService.syncAll();
      }
      return;
    }

    const stoppingId = this.activeBrowserId;
    logClientEvent("Stopping embedded browser view", { browserId: stoppingId });

    try {
      // Flush storage & cookies before closing view
      await this.view.webContents.session.cookies.flushStore();
      await this.view.webContents.session.flushStorageData();
    } catch (err) {
      logClientError("Error flushing session storage on stop", err);
    }

    try {
      this.window.contentView.removeChildView(this.view);
      this.view.webContents.close({ waitForBeforeUnload: false });
    } catch (err) {
      logClientError("Error closing WebContentsView", err);
    }

    this.view = null;
    this.currentUrl = "";
    this.isLoading = false;
    this.visible = false;

    if (stoppingId) {
      await this.profileManager.setStatus(stoppingId, "stopped");
      this.activeBrowserId = null;
    }

    this.notify();
    // Sync status update to SEO-OPS
    void this.syncService.syncAll();
  }

  async navigate(url: string): Promise<void> {
    if (!this.view) {
      throw new Error("Không có trình duyệt nào đang chạy để điều hướng.");
    }

    let normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    try {
      const parsed = new URL(normalized);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Chỉ chấp nhận URL HTTP/HTTPS.");
      }
      this.currentUrl = parsed.href;
      this.notify();
      await this.view.webContents.loadURL(parsed.href);
    } catch (err) {
      logClientError("Navigate failed", err);
      throw err;
    }
  }

  /**
   * E5.2: Detect session presence signal (e.g. c_user cookie on Facebook).
   * Strict security rule: Only checks presence (true/false).
   * NEVER saves, logs, displays, or transmits cookie value.
   */
  async checkSessionSignal(browserId?: string): Promise<SessionSignal> {
    const targetId = browserId || this.activeBrowserId;
    if (!targetId) {
      return { status: "unknown", checkedAt: null, method: null };
    }

    const profile = this.profileManager.get(targetId);
    if (!profile) {
      return { status: "unknown", checkedAt: null, method: null };
    }

    if (profile.platform.toLowerCase() === "facebook") {
      try {
        let hasCUser = false;
        if (this.view && this.activeBrowserId === targetId) {
          const cookies = await this.view.webContents.session.cookies.get({ name: "c_user" });
          hasCUser = cookies.length > 0;
        } else {
          const sess = session.fromPartition(profile.partition);
          const cookies = await sess.cookies.get({ name: "c_user" });
          hasCUser = cookies.length > 0;
        }

        const signal: SessionSignal = {
          status: hasCUser ? "present" : "absent",
          checkedAt: new Date().toISOString(),
          method: "facebook_c_user_cookie",
        };

        logClientEvent("Checked session signal for profile", {
          browserId: targetId,
          status: signal.status,
          method: signal.method,
        });

        await this.profileManager.updateSessionSignal(targetId, signal);
        void this.syncService.syncAll();
        return signal;
      } catch (err) {
        logClientError("Error checking session signal", err);
      }
    }

    const fallbackSignal: SessionSignal = {
      status: "unknown",
      checkedAt: new Date().toISOString(),
      method: null,
    };
    await this.profileManager.updateSessionSignal(targetId, fallbackSignal);
    return fallbackSignal;
  }

  goBack(): void {
    const wc = this.view?.webContents;
    if (wc?.navigationHistory?.canGoBack ? wc.navigationHistory.canGoBack() : wc?.canGoBack()) {
      wc?.navigationHistory?.goBack ? wc.navigationHistory.goBack() : wc?.goBack();
    }
  }

  goForward(): void {
    const wc = this.view?.webContents;
    if (wc?.navigationHistory?.canGoForward ? wc.navigationHistory.canGoForward() : wc?.canGoForward()) {
      wc?.navigationHistory?.goForward ? wc.navigationHistory.goForward() : wc?.goForward();
    }
  }

  reload(): void {
    this.view?.webContents.reload();
  }
}
