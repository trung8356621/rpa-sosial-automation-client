import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  type BrowserProfile,
  type BrowserStateSnapshot,
  type AccountDetail,
  detectBrowserTagFromUrl,
  isDomainMatchingAccount,
} from "../../shared/contracts.js";

interface BrowserWorkspacePanelProps {
  isActiveTab: boolean;
  onNavigateToProfiles: () => void;
  onNotify?: (msg: string) => void;
}

export function BrowserWorkspacePanel({
  isActiveTab,
  onNavigateToProfiles,
  onNotify,
}: BrowserWorkspacePanelProps) {
  const [snapshot, setSnapshot] = useState<BrowserStateSnapshot | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [checkingSignal, setCheckingSignal] = useState(false);
  const [activeAccount, setActiveAccount] = useState<AccountDetail | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [copyingPassword, setCopyingPassword] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const data = await window.client.invoke<BrowserStateSnapshot>({ type: "getBrowserState" });
      setSnapshot(data);
      if (data.viewState.currentUrl) {
        setAddressInput(data.viewState.currentUrl);
      }
    } catch {
      // ignore
    }
  }, []);

  const updateBounds = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      void window.client.invoke({
        type: "setBrowserViewBounds",
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }
  }, []);

  useEffect(() => {
    void refreshState();

    const unsub = window.client.onBrowserStateChange((next) => {
      setSnapshot(next);
      if (next.viewState.currentUrl) {
        setAddressInput(next.viewState.currentUrl);
      }
    });

    return () => unsub();
  }, [refreshState]);

  // Handle visibility & resize
  useEffect(() => {
    const hasActive = Boolean(snapshot?.activeBrowserId);
    const visible = isActiveTab && hasActive;

    void window.client.invoke({
      type: "setBrowserViewVisible",
      visible,
    });

    if (visible) {
      updateBounds();
      const observer = new ResizeObserver(() => updateBounds());
      if (containerRef.current) {
        observer.observe(containerRef.current);
      }
      window.addEventListener("resize", updateBounds);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", updateBounds);
      };
    }
  }, [isActiveTab, snapshot?.activeBrowserId, updateBounds]);

  const activeBrowserId = snapshot?.activeBrowserId;
  const activeProfile = snapshot?.profiles.find((p) => p.browserId === activeBrowserId);
  const viewState = snapshot?.viewState;

  const currentWebsiteTag = detectBrowserTagFromUrl(viewState?.currentUrl || activeProfile?.lastUrl || "");
  const activeAccountId = activeProfile?.accountBinding?.accountId ?? null;
  const activeAccountEmail = activeAccount?.email ?? null;

  useEffect(() => {
    let cancelled = false;
    setActiveAccount(null);
    setAccountError(null);
    if (!activeAccountId) return;
    void window.client.invoke<AccountDetail>({ type: "getAccount", accountId: activeAccountId })
      .then((account) => { if (!cancelled) setActiveAccount(account); })
      .catch((err: unknown) => { if (!cancelled) setAccountError((err as Error).message || "Không thể tải Account"); });
    return () => { cancelled = true; };
  }, [activeAccountId]);

  // Domain mismatch check
  const domainMatches = isDomainMatchingAccount(
    activeProfile?.platform || "",
    activeProfile?.accountBinding?.siteUrl,
    viewState?.currentUrl || activeProfile?.lastUrl
  );

  const handleNavigate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addressInput.trim() || !activeBrowserId) return;
    try {
      await window.client.invoke({
        type: "navigateBrowser",
        url: addressInput.trim(),
      });
    } catch (err: unknown) {
      const errMsg = String((err as { message?: string })?.message || "");
      if (!errMsg.includes("ERR_ABORTED") && !errMsg.includes("-3")) {
        alert(errMsg);
      }
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await window.client.invoke({ type: "stopBrowser" });
      onNotify?.("Đã dừng Browser và lưu session");
      await refreshState();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyEmail = async () => {
    try {
      if (!activeAccountId) return;
      await window.client.invoke({ type: "copyAccountEmail", accountId: activeAccountId });
      onNotify?.("Đã copy Email");
    } catch (err: unknown) {
      alert((err as Error).message || "Không thể copy email");
    }
  };

  const handleCopyPassword = async () => {
    if (!activeAccountId) return;
    setCopyingPassword(true);
    try {
      await window.client.invoke({ type: "copyAccountPassword", accountId: activeAccountId });
      onNotify?.("Đã copy mật khẩu");
    } catch (err: unknown) {
      alert((err as Error).message || "Không thể copy mật khẩu");
    } finally {
      setCopyingPassword(false);
    }
  };

  const handleCheckSignal = async () => {
    if (!activeBrowserId) return;
    setCheckingSignal(true);
    try {
      await window.client.invoke({
        type: "checkSessionSignal",
        browserId: activeBrowserId,
      });
      onNotify?.("Đã kiểm tra lại tín hiệu session");
      await refreshState();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setCheckingSignal(false);
    }
  };

  return (
    <div className="browser-workspace-container">
      {/* Top Navigation & URL Bar */}
      <div className="browser-workspace-toolbar">
        <div className="nav-controls">
          <button
            type="button"
            className="browser-btn back-profiles-btn"
            onClick={onNavigateToProfiles}
            title="Quay về trang quản lý Browser Profiles"
          >
            ← Profiles
          </button>
          <button
            type="button"
            className="browser-btn"
            disabled={!activeBrowserId || !viewState?.canGoBack}
            onClick={() => void window.client.invoke({ type: "browserGoBack" })}
            title="Quay lại (Back)"
          >
            ◀
          </button>
          <button
            type="button"
            className="browser-btn"
            disabled={!activeBrowserId || !viewState?.canGoForward}
            onClick={() => void window.client.invoke({ type: "browserGoForward" })}
            title="Tiếp theo (Forward)"
          >
            ▶
          </button>
          <button
            type="button"
            className="browser-btn"
            disabled={!activeBrowserId}
            onClick={() => void window.client.invoke({ type: "browserReload" })}
            title="Tải lại trang"
          >
            🔄
          </button>
        </div>

        <form className="address-bar-form" onSubmit={handleNavigate}>
          <span className="address-protocol-badge">
            {addressInput.startsWith("https://") ? "🔒 HTTPS" : "🌐 URL"}
          </span>
          <input
            type="text"
            className="address-input"
            placeholder="Nhập địa chỉ website (https://...)..."
            value={addressInput}
            disabled={!activeBrowserId}
            onChange={(e) => setAddressInput(e.target.value)}
          />
          {viewState?.isLoading && <span className="loading-spinner">⌛</span>}
          <button
            type="submit"
            className="browser-btn go-btn"
            disabled={!activeBrowserId || !addressInput.trim()}
          >
            Truy cập
          </button>
        </form>

        {activeBrowserId && (
          <button
            type="button"
            className="btn btn-secondary stop-browser-btn"
            onClick={handleStop}
            disabled={actionLoading}
            title="Đóng trình duyệt hiện tại và flush cookies/session data"
          >
            ⏹ Dừng Browser
          </button>
        )}
      </div>

      {/* Sub-bar: Active Account & Current Website & Signals */}
      {activeProfile && (
        <div className="browser-workspace-subbar">
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              Account: <strong>{activeProfile.accountBinding?.accountName || activeAccount?.displayName || "Legacy Browser"}</strong>
            </span>

            {/* Current Website auto-detected from URL */}
            <span className="site-tag-pill">
              🌐 Website: <strong>{currentWebsiteTag}</strong>
            </span>

            {/* Linked Account info */}
            {activeProfile.accountBinding?.accountId ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="account-tag-pill">
                  👤 Account: {activeProfile.accountBinding.accountName || activeProfile.accountBinding.accountId.slice(0, 8)}
                  {activeAccountEmail && (
                    <span style={{ opacity: 0.85, marginLeft: 4 }}>({activeAccountEmail})</span>
                  )}
                  <span style={{ opacity: 0.65, marginLeft: 4 }}>[{activeProfile.platform}]</span>
                </span>

                {/* Domain mismatch warning */}
                {!domainMatches && (
                  <span
                    className="warning-badge"
                    title={`Domain đang mở (${currentWebsiteTag}) không thuộc nền tảng hoặc cấu hình của Account (${activeProfile.platform})`}
                  >
                    ⚠️ Domain khác Account
                  </span>
                )}

                {/* Credentials buttons */}
                {activeAccountEmail && (
                  <button
                    type="button"
                    className="link-action-btn credential-btn"
                    onClick={() => void handleCopyEmail()}
                    title="Copy email vào clipboard"
                  >
                    📋 Copy Email
                  </button>
                )}

                <button
                  type="button"
                  className={`link-action-btn credential-btn ${activeAccount?.passwordStatus !== "available" ? "disabled" : ""}`}
                  onClick={() => void handleCopyPassword()}
                  disabled={copyingPassword || activeAccount?.passwordStatus !== "available"}
                  title={accountError || "Copy mật khẩu"}
                >
                  🔑 {accountError ? "Lỗi tải trạng thái" : activeAccount?.passwordStatus === "available" ? (copyingPassword ? "Đang copy..." : "Copy Password") : activeAccount?.passwordStatus === "not_set" ? "Chưa lưu mật khẩu" : "Đang kiểm tra..."}
                </button>
              </div>
            ) : (
              <span style={{ color: "#ef4444" }}>⚠️ Chưa liên kết Account</span>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {activeProfile.sessionSignal?.status === "present" ? (
              <span className="signal-pill present">● Có tín hiệu phiên</span>
            ) : activeProfile.sessionSignal?.status === "absent" ? (
              <span className="signal-pill absent">○ Không phát hiện tín hiệu đăng nhập</span>
            ) : activeProfile.sessionSignal?.status === "unsupported" ? (
              <span className="signal-pill unknown">Không hỗ trợ kiểm tra website này</span>
            ) : activeProfile.sessionSignal?.status === "error" ? (
              <span className="signal-pill absent" title={activeProfile.sessionSignal.error || undefined}>Lỗi kiểm tra session</span>
            ) : (
              <span className="signal-pill unknown">Tín hiệu: Chưa kiểm tra</span>
            )}
            <button
              type="button"
              className="link-action-btn"
              onClick={handleCheckSignal}
              disabled={checkingSignal || !activeBrowserId}
              title="Kiểm tra lại tín hiệu cookie cho website này"
            >
              {checkingSignal ? "⌛" : "🔄"}
            </button>
          </div>
        </div>
      )}

      {/* Page Load Failure Warning (if real error occurred) */}
      {viewState?.lastError && (
        <div className="browser-error-banner">
          <span>⚠️ {viewState.lastError}</span>
          <button
            type="button"
            className="browser-btn"
            style={{ padding: "2px 8px", fontSize: 11 }}
            onClick={() => void window.client.invoke({ type: "browserReload" })}
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Embedded WebContentsView Anchor: occupies all remaining space */}
      <div ref={containerRef} className="browser-workspace-viewport">
        {!activeBrowserId && (
          <div className="browser-workspace-empty">
            <div style={{ fontSize: 40, marginBottom: 12 }}>🌐</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>
              Chưa có Browser nào đang mở
            </div>
            <div style={{ color: "#64748b", maxWidth: 460, fontSize: 13, marginBottom: 16 }}>
              Vui lòng quay lại danh sách Browser Profiles để chọn một Profile đã liên kết Account và mở trình duyệt làm việc.
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onNavigateToProfiles}
            >
              ← Đến danh sách Browser Profiles
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
