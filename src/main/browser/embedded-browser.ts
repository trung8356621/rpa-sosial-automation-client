import { WebContentsView, session, type BrowserWindow, type WebContents } from "electron";
import type { BrowserProfile, BrowserViewState, SessionSignal } from "../../shared/contracts.js";
import type { ProfileManager } from "./profile-manager.js";
import type { BrowserSyncService } from "./browser-sync-service.js";
import { resolveInitialUrl } from "./url-resolver.js";
import {
  cookieBelongsToHost,
  evaluateSessionCookies,
  evaluateWordPressSession,
  isWordPressAuthCookieName,
  resolveBrowserOpenUrl,
  resolveSessionStrategy,
  type WordPressDomEvidence,
} from "./session-signal-strategy.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import type { BrowserOpenOrchestrator } from "../auth/browser-open-orchestrator.js";
import type { AuthContextFinder } from "../auth/auth-context-finder.js";
import { hasExplicitTagContext, type AuthTagContext } from "../auth/auth-script-types.js";
import type { AuthPipelineResult } from "../auth/outcomes.js";
import {
  attachBrowserClipboardIsolation,
  resolveBrowserClipboardPreloadPath,
  type BrowserClipboardIsolationHandle,
} from "./browser-clipboard-isolation.js";
import { BrowserInteractionLock } from "./browser-interaction-lock.js";

export class EmbeddedBrowser {
  private view: WebContentsView | null = null;
  private activeBrowserId: string | null = null;
  private currentUrl = "";
  private isLoading = false;
  private visible = false;
  private lastError: string | null = null;
  private bounds = { x: 260, y: 120, width: 680, height: 560 };
  private stateListeners = new Set<(state: BrowserViewState) => void>();
  private authOrchestrator: BrowserOpenOrchestrator | null = null;
  private authContextFinder: AuthContextFinder | null = null;
  private lastAuthResult: AuthPipelineResult | null = null;
  private clipboardIsolation: BrowserClipboardIsolationHandle | null = null;
  private readonly interactionLock: BrowserInteractionLock;
  private authAbort: AbortController | null = null;
  private jobAbortHandler: (() => void) | null = null;
  private humanResumeWait: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly profileManager: ProfileManager,
    private readonly syncService: BrowserSyncService
  ) {
    this.interactionLock = new BrowserInteractionLock(window);
    this.interactionLock.onStateChange(() => this.notify());
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
    const lock = this.interactionLock.getState();
    return {
      activeBrowserId: this.activeBrowserId,
      currentUrl: this.currentUrl,
      isLoading: this.isLoading,
      canGoBack: Boolean(wc?.navigationHistory?.canGoBack ? wc.navigationHistory.canGoBack() : wc?.canGoBack()),
      canGoForward: Boolean(wc?.navigationHistory?.canGoForward ? wc.navigationHistory.canGoForward() : wc?.canGoForward()),
      visible: this.visible,
      lastError: this.lastError,
      lastAuthCode: this.lastAuthResult?.code ?? null,
      lastAuthMessage: this.lastAuthResult?.message ?? null,
      automationLock: {
        mode: lock.mode,
        message: lock.message,
        reason: lock.reason,
      },
    };
  }

  getWebContents() {
    return this.view?.webContents;
  }

  getActiveBrowserId(): string | null {
    return this.activeBrowserId;
  }

  setAuthOrchestrator(orchestrator: BrowserOpenOrchestrator | null): void {
    this.authOrchestrator = orchestrator;
  }

  setAuthContextFinder(finder: AuthContextFinder | null): void {
    this.authContextFinder = finder;
  }

  getLastAuthResult(): AuthPipelineResult | null {
    return this.lastAuthResult;
  }

  stopAutomation(): void {
    this.authAbort?.abort();
    this.jobAbortHandler?.();
    this.interactionLock.requestStopFromUi();
    if (this.humanResumeWait) {
      this.humanResumeWait.reject(new Error("AUTH_CANCELLED"));
      this.humanResumeWait = null;
    }
    void this.interactionLock.release("user_stop");
    this.notify();
  }

  /** Campaign Job / Action Script overlay lock (same native overlay as Auth). */
  async lockForAutomation(params: {
    message?: string;
    reason?: string;
    onStop?: () => void;
  }): Promise<void> {
    this.jobAbortHandler = params.onStop ?? null;
    await this.interactionLock.lock({
      message: params.message,
      reason: params.reason,
      onStop: () => {
        this.jobAbortHandler?.();
      },
    });
  }

  async releaseAutomationLock(reason = "complete"): Promise<void> {
    this.jobAbortHandler = null;
    await this.interactionLock.release(reason);
  }

  resumeAutomationAfterHuman(): void {
    this.interactionLock.requestResumeFromUi();
    if (this.humanResumeWait) {
      this.humanResumeWait.resolve();
      this.humanResumeWait = null;
    }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
    if (this.view) {
      this.view.setBounds(bounds);
    }
    this.interactionLock.setBounds(bounds);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }

  /** Temporarily size the browser view for Creator Visual ORC (restore via restoreAuthViewport). */
  private boundsBeforeAuth: { x: number; y: number; width: number; height: number } | null = null;

  applyAuthViewport(size: { width: number; height: number }): void {
    if (!this.boundsBeforeAuth) {
      this.boundsBeforeAuth = { ...this.bounds };
    }
    this.setBounds({
      x: this.bounds.x,
      y: this.bounds.y,
      width: size.width,
      height: size.height,
    });
  }

  restoreAuthViewport(): void {
    if (this.boundsBeforeAuth) {
      this.setBounds(this.boundsBeforeAuth);
      this.boundsBeforeAuth = null;
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

  async open(browserId: string, initialUrl?: string, tag?: AuthTagContext | null): Promise<void> {
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
      // Already running: do not reload or recreate WebContentsView / partition.
      logClientEvent("Browser already open — reuse partition", {
        browserId,
        partition: profile.partition,
        currentUrl: this.currentUrl || null,
      });
      this.setVisible(true);
      // Re-run Auth+Checkpoint: explicit Tag or Account auth/context discovery.
      await this.runAuthPipeline(browserId, profile, tag);
      return;
    }

    logClientEvent("Starting embedded browser view", {
      browserId,
      accountId: profile.accountBinding?.accountId,
      accountName: profile.accountBinding?.accountName,
      partition: profile.partition,
      hasActionTagContext: Boolean(tag?.actionTagId || tag?.actionTagKey),
    });

    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partition,
        preload: resolveBrowserClipboardPreloadPath(),
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

    // Per-profile virtual clipboard — never writes/reads OS clipboard.
    this.clipboardIsolation?.dispose();
    this.clipboardIsolation = attachBrowserClipboardIsolation(wc, browserId);

    // Window open & navigation safety (popups stay in same isolated WebContents)
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

    // Initial navigation: avoid reopening wp-login?reauth= which can clear a valid session.
    const targetUrl = resolveBrowserOpenUrl({
      initialUrl,
      lastUrl: profile.lastUrl,
      siteUrl: profile.accountBinding?.siteUrl,
      platform: profile.platform,
      fallback: resolveInitialUrl,
    });

    logClientEvent("Browser open navigation target", {
      browserId,
      partition: profile.partition,
      targetUrl,
      lastUrl: profile.lastUrl ?? null,
    });

    await this.navigate(targetUrl).catch((err) => {
      logClientError("Initial browser navigation failed", err);
    });

    // Auth Script (optional Tag context) then existing Checkpoint — same partition.
    await this.runAuthPipeline(browserId, profile, tag);

    // Sync status change to SEO-OPS
    void this.syncService.syncAll();
  }

  private async runAuthPipeline(
    browserId: string,
    profile: BrowserProfile,
    tag?: AuthTagContext | null
  ): Promise<void> {
    const accountId = profile.accountBinding?.accountId;
    if (!accountId) return;

    const runCheckpoint = (opts?: { settle?: boolean }) =>
      this.checkSessionSignal(browserId, { settle: opts?.settle !== false });

    if (!this.authOrchestrator) {
      // Compatibility: no orchestrator wired → existing Checkpoint only.
      void runCheckpoint();
      return;
    }

    this.authAbort?.abort();
    this.authAbort = new AbortController();
    const signal = this.authAbort.signal;

    try {
      let resolvedTag: AuthTagContext | null | undefined = tag;
      if (!hasExplicitTagContext(resolvedTag)) {
        resolvedTag = await this.resolveTagFromAccountContext(accountId);
        if (resolvedTag === null) {
          // Ambiguous / hard error already recorded — Checkpoint only.
          await runCheckpoint();
          return;
        }
      }

      let username: string | null = null;
      let email = profile.accountBinding?.email ?? null;
      let siteUrl = profile.accountBinding?.siteUrl ?? null;
      try {
        const detail = await this.syncService.getAccount(accountId);
        username = detail.username;
        email = detail.email ?? email;
        siteUrl = detail.siteUrl ?? siteUrl;
      } catch {
        // Offline / API failure — continue with local binding metadata; password fetch may still fail closed.
      }
      if (!username) {
        try {
          const listed = await this.syncService.getAccounts(profile.platform);
          const match = listed.find((a) => a.accountId === accountId);
          username = match?.username ?? null;
          email = email ?? match?.email ?? null;
        } catch {
          // ignore
        }
      }

      const willLikelyRunAuth = hasExplicitTagContext(resolvedTag);
      if (willLikelyRunAuth) {
        await this.interactionLock.lock({
          reason: "auth_script",
          onStop: () => {
            this.authAbort?.abort();
          },
        });
      }

      let result = await this.authOrchestrator.runAfterBrowserOpen({
        browserId,
        accountId,
        partition: profile.partition,
        tag: resolvedTag,
        webContents: this.view?.webContents,
        account: {
          accountId,
          username,
          email,
          siteUrl,
          getPassword: () => this.syncService.getAccountPassword(accountId, browserId),
        },
        runCheckpoint,
        signal,
      });

      // HUMAN_REQUIRED: unlock for user, wait for resume, relock, then stop (no second Auth).
      if (result.code === "HUMAN_REQUIRED") {
        await this.interactionLock.unlockForHuman({
          reason: "HUMAN_REQUIRED",
          message: result.message,
        });
        this.lastAuthResult = result;
        this.lastError = result.message;
        this.notify();
        try {
          await this.waitForHumanResume(signal);
          await this.interactionLock.relockAfterHuman({
            reason: "resume_after_human",
            onStop: () => this.authAbort?.abort(),
          });
          // Do not re-run Auth in the same execution — Checkpoint only after human.
          const afterHuman = await runCheckpoint();
          result = {
            ...result,
            code: afterHuman.status === "present" ? "CHECKPOINT_PASSED" : "CHECKPOINT_FAILED",
            phase: "checkpoint",
            checkpointStatus: afterHuman.status,
            message:
              afterHuman.status === "present"
                ? "HUMAN_REQUIRED đã xử lý; Checkpoint PRESENT."
                : "HUMAN_REQUIRED đã xử lý nhưng Checkpoint chưa PASS — dừng, không retry Auth.",
          };
        } catch {
          result = {
            ...result,
            code: "AUTH_CANCELLED",
            message: "Auth bị hủy trong lúc chờ xác minh thủ công.",
          };
        }
      }

      this.lastAuthResult = result;
      logClientEvent("Auth pipeline finished", {
        browserId,
        code: result.code,
        phase: result.phase,
        authExecutionOk: result.authExecutionOk,
        checkpointStatus: result.checkpointStatus,
        packageKey: result.packageKey,
        releaseId: result.releaseId,
        version: result.version,
        actionTagId: result.actionTagId,
        actionTagKey: result.actionTagKey,
        authRuns: result.authRuns,
      });
      if (
        result.code === "AUTH_EXECUTION_FAILED" ||
        result.code === "AUTH_TIMEOUT" ||
        result.code === "AUTH_INTEGRITY_FAILED" ||
        result.code === "AUTH_DOWNLOAD_FAILED" ||
        result.code === "ORC_RUNTIME_UNAVAILABLE" ||
        result.code === "ASSET_DOWNLOAD_UNAVAILABLE" ||
        result.code === "ASSET_INTEGRITY_FAILED" ||
        result.code === "VIEWPORT_MISMATCH" ||
        result.code === "NO_ACCOUNT_TAG_ENTITLEMENT" ||
        result.code === "CLIENT_LEASE_INVALID" ||
        result.code === "AUTH_CONTEXT_AMBIGUOUS" ||
        result.code === "AUTH_CONTEXT_UNAVAILABLE" ||
        result.code === "AUTH_CANCELLED" ||
        result.code === "CHECKPOINT_FAILED" ||
        result.code === "SESSION_UNKNOWN" ||
        result.code === "HUMAN_REQUIRED"
      ) {
        this.lastError = result.message;
      }
      this.notify();
    } catch (err) {
      logClientError("Auth pipeline unexpected error — Browser remains open for manual login", err);
      void runCheckpoint();
    } finally {
      await this.interactionLock.release("auth_pipeline_end");
      this.authAbort = null;
      this.notify();
    }
  }

  /**
   * Profile Open bridge: Account ID → Addon auth/context → 0/1/N eligible tags.
   * Returns undefined when none (manual login). Returns null when ambiguous/error (stop Auth).
   */
  private async resolveTagFromAccountContext(
    accountId: string
  ): Promise<AuthTagContext | null | undefined> {
    if (!this.authContextFinder) {
      logClientEvent("AUTH_SKIPPED", {
        reason: "no_auth_context_finder",
        accountId,
      });
      return undefined;
    }

    const found = await this.authContextFinder.findForAccount(accountId);
    if (found.kind === "none") {
      this.lastAuthResult = {
        code: "NO_AUTH_CONFIGURED",
        phase: "skipped",
        authExecutionOk: false,
        checkpointStatus: "unknown",
        message: found.message,
        authRuns: 0,
      };
      return undefined;
    }
    if (found.kind === "unique") {
      return found.tag;
    }
    if (found.kind === "ambiguous") {
      this.lastAuthResult = {
        code: "AUTH_CONTEXT_AMBIGUOUS",
        phase: "skipped",
        authExecutionOk: false,
        checkpointStatus: "unknown",
        message: found.message,
        authRuns: 0,
      };
      this.lastError = found.message;
      this.notify();
      return null;
    }
    this.lastAuthResult = {
      code: found.code === "CLIENT_LEASE_INVALID" ? found.code : "AUTH_CONTEXT_UNAVAILABLE",
      phase: "skipped",
      authExecutionOk: false,
      checkpointStatus: "unknown",
      message: found.message,
      serverError: found.serverError,
      authRuns: 0,
    };
    // Offline / endpoint missing → fail closed to manual login (do not invent tag).
    logClientEvent("AUTH_SKIPPED", {
      reason: "auth_context_error",
      code: found.code,
      accountId,
    });
    return undefined;
  }

  private waitForHumanResume(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("AUTH_CANCELLED"));
        return;
      }
      const onAbort = () => {
        this.humanResumeWait = null;
        reject(new Error("AUTH_CANCELLED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.humanResumeWait = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      this.notify();
    });
  }

  async stop(): Promise<void> {
    this.authAbort?.abort();
    this.authAbort = null;
    if (this.humanResumeWait) {
      this.humanResumeWait.reject(new Error("AUTH_CANCELLED"));
      this.humanResumeWait = null;
    }
    await this.interactionLock.release("browser_stop");

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
      this.clipboardIsolation?.dispose();
    } catch (err) {
      logClientError("Error disposing clipboard isolation", err);
    }
    this.clipboardIsolation = null;

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
   * Detect authentication for the profile's persistent partition.
   * Strict security: only presence / DOM evidence — NEVER log cookie values.
   * WordPress POC: auth cookies OR (/wp-admin/ URL + #wpadminbar / admin DOM).
   */
  async checkSessionSignal(
    browserId?: string,
    opts?: { settle?: boolean; settleMs?: number }
  ): Promise<SessionSignal> {
    const targetId = browserId || this.activeBrowserId;
    if (!targetId) {
      return { status: "unknown", checkedAt: null, method: null };
    }

    const profile = this.profileManager.get(targetId);
    if (!profile) {
      return { status: "unknown", checkedAt: null, method: null };
    }

    const wc =
      this.activeBrowserId === targetId && this.view && !this.view.webContents.isDestroyed()
        ? this.view.webContents
        : null;

    const targetUrl =
      (wc ? this.currentUrl : "") ||
      profile.lastUrl ||
      profile.accountBinding?.siteUrl ||
      "";
    if (!targetUrl) {
      const unsupported: SessionSignal = {
        status: "unsupported",
        checkedAt: new Date().toISOString(),
        method: null,
      };
      await this.profileManager.updateSessionSignal(targetId, unsupported);
      return unsupported;
    }

    try {
      const settle = opts?.settle === true;
      const settleMs = opts?.settleMs ?? (settle ? 12_000 : 0);
      const deadline = Date.now() + settleMs;
      let signal: SessionSignal = {
        status: "unknown",
        checkedAt: new Date().toISOString(),
        method: null,
      };

      do {
        if (wc) {
          await this.waitForNavigationIdle(wc, 2_500);
        }

        const pageUrl = (wc ? this.currentUrl : "") || targetUrl;
        const parsed = new URL(pageUrl);
        const strategy = resolveSessionStrategy(parsed.href, profile.accountBinding?.siteUrl);
        const profileSession = session.fromPartition(profile.partition);

        // Persist in-memory Set-Cookie before reading partition (same partition as WC).
        if (wc && wc.session === profileSession) {
          try {
            await profileSession.cookies.flushStore();
          } catch {
            /* non-fatal */
          }
        }

        if (strategy === "facebook") {
          const cookies = await profileSession.cookies.get({
            url: parsed.origin,
            name: "c_user",
          });
          signal = evaluateSessionCookies(strategy, cookies, new Date().toISOString());
          logClientEvent("Checked session signal for profile", {
            browserId: targetId,
            status: signal.status,
            method: signal.method,
            partition: profile.partition,
            origin: parsed.origin,
            pagePath: parsed.pathname,
            cookieNames: cookies.map((c) => c.name),
            settle,
          });
        } else if (strategy === "wordpress") {
          const originCookies = await profileSession.cookies.get({
            url: `${parsed.origin}/`,
          });
          const allCookies = await profileSession.cookies.get({});
          const hostCookies = allCookies.filter((c) =>
            cookieBelongsToHost(c.domain, parsed.hostname)
          );
          const merged = new Map<string, { name: string; domain?: string }>();
          for (const c of [...originCookies, ...hostCookies]) {
            merged.set(c.name, { name: c.name, domain: c.domain });
          }
          const cookies = [...merged.values()];
          const authCookieNames = cookies
            .filter((c) => isWordPressAuthCookieName(c.name))
            .map((c) => c.name);
          const dom = wc ? await this.probeWordPressDom(wc) : null;
          signal = evaluateWordPressSession({
            cookies,
            pageUrl,
            dom,
            checkedAt: new Date().toISOString(),
          });
          logClientEvent("Checked session signal for profile", {
            browserId: targetId,
            status: signal.status,
            method: signal.method,
            partition: profile.partition,
            origin: parsed.origin,
            pagePath: parsed.pathname,
            cookieNames: authCookieNames,
            cookieCountForHost: cookies.length,
            dom,
            settle,
          });
        } else {
          signal = evaluateSessionCookies(strategy, [], new Date().toISOString());
          logClientEvent("Checked session signal for profile", {
            browserId: targetId,
            status: signal.status,
            method: signal.method,
            partition: profile.partition,
            origin: parsed.origin,
            pagePath: parsed.pathname,
            settle,
          });
        }

        if (signal.status === "present" || !settle || Date.now() >= deadline) {
          break;
        }
        await sleepMs(250);
      } while (Date.now() < deadline);

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

  private async waitForNavigationIdle(wc: WebContents, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (typeof wc.isLoading === "function" && wc.isLoading()) {
      if (Date.now() - started > timeoutMs) break;
      await sleepMs(100);
    }
    // One frame after load — login redirects often settle here.
    try {
      await wc.executeJavaScript(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
        true
      );
    } catch {
      /* ignore */
    }
  }

  private async probeWordPressDom(wc: WebContents): Promise<WordPressDomEvidence> {
    try {
      const dom = (await wc.executeJavaScript(
        `(() => {
          const body = document.body;
          return {
            hasAdminBar: Boolean(document.querySelector("#wpadminbar")),
            hasWpBody: Boolean(document.querySelector("#wpbody")),
            bodyHasWpAdmin: Boolean(body && body.classList && body.classList.contains("wp-admin")),
          };
        })()`,
        true
      )) as WordPressDomEvidence;
      return {
        hasAdminBar: Boolean(dom?.hasAdminBar),
        hasWpBody: Boolean(dom?.hasWpBody),
        bodyHasWpAdmin: Boolean(dom?.bodyHasWpAdmin),
      };
    } catch {
      return { hasAdminBar: false, hasWpBody: false, bodyHasWpAdmin: false };
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
