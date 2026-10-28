import { WebContentsView, session, type BrowserWindow } from "electron";
import type { BrowserProfile, BrowserViewState, SessionSignal } from "../../shared/contracts.js";
import type { ProfileManager } from "./profile-manager.js";
import type { BrowserSyncService } from "./browser-sync-service.js";
import { resolveInitialUrl } from "./url-resolver.js";
import { evaluateSessionCookies, resolveSessionStrategy } from "./session-signal-strategy.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export class EmbeddedBrowser {
  private view: WebContentsView | null = null;
  private activeBrowserId: string | null = null;
  private currentUrl = "";
  private isLoading = false;
  private visible = false;
  private lastError: string | null = null;
  private bounds = { x: 260, y: 120, width: 680, height: 560 };
  private stateListeners = new Set<(state: BrowserViewState) => void>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly profileManager: ProfileManager,
    private readonly syncService: BrowserSyncService
  ) {
    // When account changes on a profile, reset partition storage to avoid cross-account session pollution
    this.profileManager.setSessionResetCallback(async (browserId, partition) => {
      if (this.activeBrowserId === browserId) {
        await this.stop();
      }
      await this.clearPartitionStorage(partition);
    });
  }

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
      lastError: this.lastError,
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

  async clearPartitionStorage(partition: string): Promise<void> {
    try {
      const sess = session.fromPartition(partition);
      await sess.clearStorageData();
      logClientEvent("Cleared partition storage and cookies", { partition });
    } catch (err) {
      logClientError("Error clearing partition storage", err);
    }
  }

  async open(browserId: string, initialUrl?: string): Promise<void> {
    const profile = this.profileManager.get(browserId);
    if (!profile) {
      throw new Error(`Profile ${browserId} không tồn tại.`);
    }

    // Requirement 6: Profile without bound account cannot run without binding
    if (!profile.accountBinding?.accountId) {
      throw new Error("Browser Profile chưa được liên kết với Account SEO-OPS. Vui lòng liên kết Account trước.");
    }

    // Single active browser constraint: Close current if open for a different profile
    if (this.view && this.activeBrowserId !== browserId) {
      await this.stop();
    }

    if (this.view && this.activeBrowserId === browserId) {
      // Already running: do not reload or recreate WebContentsView
      if (initialUrl && initialUrl !== this.currentUrl) {
        await this.navigate(initialUrl);
      }
      this.setVisible(true);
      return;
    }

    logClientEvent("Starting embedded browser view", {
      browserId,
      accountId: profile.accountBinding?.accountId,
      accountName: profile.accountBinding?.accountName,
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
    this.lastError = null;
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

    // Handle real navigation failure (e.g. DNS, connection refused)
    // ERR_ABORTED (-3) is expected on redirects/superseded loads and strictly ignored
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) {
        // Navigation was aborted/redirected, normal in Chromium
        return;
      }
      this.isLoading = false;
      this.lastError = `${errorDescription} (${errorCode}) khi tải ${validatedURL}`;
      logClientError("Page load failed", { errorCode, errorDescription, validatedURL });
      this.notify();
    });

    const updateUrl = (url: string) => {
      if (/^https?:\/\//.test(url)) {
        this.currentUrl = url;
        this.lastError = null;
        void this.profileManager.recordUrl(browserId, url);
        void this.checkSessionSignal(browserId);
        this.notify();
      }
    };

    wc.on("did-navigate", (_event, url) => updateUrl(url));
    wc.on("did-navigate-in-page", (_event, url) => updateUrl(url));

    // Mount to window contentView
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    this.setVisible(true);

    // Initial navigation: automatically determine website URL from platform and site_url
    let targetUrl = initialUrl || profile.lastUrl;
    if (!targetUrl) {
      targetUrl = resolveInitialUrl(profile.platform, profile.accountBinding?.siteUrl);
    }

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
    this.lastError = null;

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

      // Avoid racing duplicate loadURL if already navigating to this exact URL
      if (this.currentUrl === parsed.href && this.isLoading) {
        return;
      }

      this.currentUrl = parsed.href;
      this.lastError = null;
      this.notify();

      try {
        await this.view.webContents.loadURL(parsed.href);
      } catch (err: unknown) {
        const anyErr = err as { code?: string; errno?: number; message?: string };
        const errMsg = String(anyErr?.message || "");
        if (
          anyErr?.code === "ERR_ABORTED" ||
          anyErr?.errno === -3 ||
          errMsg.includes("ERR_ABORTED") ||
          errMsg.includes("-3")
        ) {
          // Navigation was aborted (e.g. redirected or superseded), which is expected in Chromium
          return;
        }
        this.lastError = errMsg;
        this.notify();
        logClientError("Navigate failed", err);
        throw err;
      }
    } catch (err: unknown) {
      const errMsg = String((err as { message?: string })?.message || "");
      if (errMsg.includes("ERR_ABORTED") || errMsg.includes("-3")) {
        return;
      }
      throw err;
    }
  }

  /**
   * Detect a site-specific authentication cookie in the profile's persistent partition.
   * Strict security rule: Only checks presence (true/false).
   * NEVER saves, logs, displays, or transmits cookie value.
   * Requirement 5: Do NOT assign session signal of unrelated website to current account.
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

    const targetUrl =
      this.activeBrowserId === targetId && this.currentUrl
        ? this.currentUrl
        : profile.lastUrl || profile.accountBinding?.siteUrl || "";
    if (!targetUrl) {
      const unsupported: SessionSignal = { status: "unsupported", checkedAt: new Date().toISOString(), method: null };
      await this.profileManager.updateSessionSignal(targetId, unsupported);
      return unsupported;
    }

    try {
      const parsed = new URL(targetUrl);
      const strategy = resolveSessionStrategy(parsed.href, profile.accountBinding?.siteUrl);
      const profileSession = session.fromPartition(profile.partition);
      const cookies = strategy === "facebook"
        ? await profileSession.cookies.get({ url: parsed.origin, name: "c_user" })
        : strategy === "wordpress"
          ? await profileSession.cookies.get({ url: parsed.href })
          : [];
      const signal = evaluateSessionCookies(strategy, cookies, new Date().toISOString());

      logClientEvent("Checked session signal for profile", {
        browserId: targetId,
        status: signal.status,
        method: signal.method,
        partition: profile.partition,
        origin: parsed.origin,
      });
      await this.profileManager.updateSessionSignal(targetId, signal);
      await this.syncService.syncAll();
      return signal;
    } catch (err) {
      logClientError("Error checking session signal", err);
      const failure: SessionSignal = {
        status: "error",
        checkedAt: new Date().toISOString(),
        method: null,
        error: "Không thể đọc cookie từ Browser Profile.",
      };
      await this.profileManager.updateSessionSignal(targetId, failure);
      return failure;
    }
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
