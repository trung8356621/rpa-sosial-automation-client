import React, { useEffect, useState, useCallback } from "react";
import {
  type BrowserProfile,
  type BrowserStateSnapshot,
  type AccountInfo,
  detectBrowserTagFromUrl,
} from "../../shared/contracts.js";

interface BrowserProfilesPanelProps {
  onNotify?: (msg: string) => void;
  onOpenBrowser?: (browserId: string) => void;
}

export function BrowserProfilesPanel({ onNotify, onOpenBrowser }: BrowserProfilesPanelProps) {
  const [snapshot, setSnapshot] = useState<BrowserStateSnapshot | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Account-first selection state
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [modalTargetProfile, setModalTargetProfile] = useState<BrowserProfile | null>(null);
  const [availableAccounts, setAvailableAccounts] = useState<AccountInfo[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [checkingSignalId, setCheckingSignalId] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const data = await window.client.invoke<BrowserStateSnapshot>({ type: "getBrowserState" });
      setSnapshot(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshState();

    const unsub = window.client.onBrowserStateChange((next) => {
      setSnapshot(next);
    });

    return () => unsub();
  }, [refreshState]);

  const loadAccounts = async (platform?: string) => {
    setLoadingAccounts(true);
    try {
      const list = await window.client.invoke<AccountInfo[]>({
        type: "getAccounts",
        platform,
      });
      setAvailableAccounts(list);
    } catch (err) {
      console.error("Lỗi lấy danh sách account", err);
    } finally {
      setLoadingAccounts(false);
    }
  };

  const openAccountPickerForNewBrowser = () => {
    setModalTargetProfile(null);
    setShowAccountModal(true);
    void loadAccounts();
  };

  const handleSelectAccount = async (acc: AccountInfo) => {
    setActionLoading(true);
    try {
      if (modalTargetProfile) {
        // Binding or switching account for an existing profile
        const prevAccountId = modalTargetProfile.accountBinding?.accountId;
        if (prevAccountId && prevAccountId !== acc.accountId) {
          const ok = window.confirm(
            `Đổi sang Account "${acc.displayName}" sẽ reset phiên làm việc (cookies/session data) của Account cũ để đảm bảo không dùng nhầm session. Bạn có chắc chắn muốn đổi?`
          );
          if (!ok) {
            setActionLoading(false);
            return;
          }
        }

        await window.client.invoke({
          type: "bindAccount",
          browserId: modalTargetProfile.browserId,
          accountId: acc.accountId,
          accountName: acc.displayName,
          email: acc.email,
          siteUrl: acc.siteUrl,
          platform: acc.platform,
        });

        setShowAccountModal(false);
        setModalTargetProfile(null);
        onNotify?.(`Đã liên kết profile với account "${acc.displayName}"`);
        await refreshState();
      } else {
        // Account-First: Create new browser profile from Account
        // Check if an existing profile for this account already exists on device
        const existingProfile = snapshot?.profiles.find(
          (p) => p.accountBinding?.accountId === acc.accountId
        );

        if (existingProfile) {
          setShowAccountModal(false);
          const existingLabel =
            existingProfile.accountBinding?.accountName ||
            existingProfile.accountBinding?.email ||
            acc.displayName ||
            "Account";
          onNotify?.(`Account đã có Browser Profile cho "${existingLabel}". Đang mở profile hiện có...`);
          await window.client.invoke({
            type: "openBrowser",
            browserId: existingProfile.browserId,
          });
          await refreshState();
          onOpenBrowser?.(existingProfile.browserId);
          return;
        }

        const result = await window.client.invoke<{ profile: BrowserProfile; alreadyExists: boolean }>({
          type: "createBrowserForAccount",
          account: acc,
        });

        setShowAccountModal(false);
        const createdLabel =
          result.profile.accountBinding?.accountName ||
          acc.displayName ||
          "Account";
        onNotify?.(`Đã tạo Browser Profile cho "${createdLabel}". Đang tự mở website...`);

        // Auto open browser for newly created profile
        await window.client.invoke({
          type: "openBrowser",
          browserId: result.profile.browserId,
        });
        await refreshState();
        onOpenBrowser?.(result.profile.browserId);
      }
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (profile: BrowserProfile) => {
    if (profile.status === "running") {
      alert("Không thể xóa profile đang chạy. Hãy dừng trình duyệt trước.");
      return;
    }
    const deleteLabel =
      profile.accountBinding?.accountName ||
      profile.accountBinding?.email ||
      "Chưa liên kết Account";
    const ok = window.confirm(
      `Bạn có chắc chắn muốn xóa Browser của "${deleteLabel}"?\n(Dữ liệu Account trên SEO-OPS không bị ảnh hưởng, chỉ xóa profile local của máy này)`
    );
    if (!ok) return;

    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "deleteBrowserProfile",
        browserId: profile.browserId,
      });
      onNotify?.("Đã xóa Browser Profile");
      await refreshState();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpen = async (profile: BrowserProfile) => {
    // If profile has no account bound, mandate selecting an account first
    if (!profile.accountBinding?.accountId) {
      alert("Browser legacy chưa liên kết Account không thể mở để dispatch. Hãy xóa và tạo lại từ Account.");
      return;
    }

    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "openBrowser",
        browserId: profile.browserId,
      });
      onNotify?.("Đã mở trình duyệt");
      await refreshState();
      onOpenBrowser?.(profile.browserId);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "stopBrowser",
      });
      onNotify?.("Đã dừng trình duyệt và lưu phiên làm việc");
      await refreshState();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCheckSignal = async (profile: BrowserProfile) => {
    setCheckingSignalId(profile.browserId);
    try {
      await window.client.invoke({
        type: "checkSessionSignal",
        browserId: profile.browserId,
      });
      onNotify?.("Đã đồng bộ tín hiệu session (không xác nhận đăng nhập)");
      await refreshState();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setCheckingSignalId(null);
    }
  };

  const profiles = snapshot?.profiles ?? [];
  const activeBrowserId = snapshot?.activeBrowserId;

  return (
    <div className="browser-page-layout">
      {/* Profile Management Section */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div className="card-title">Browser Profiles ({profiles.length})</div>
            <div className="card-desc">
              Khởi tạo Browser trực tiếp từ Account SEO-OPS. Hệ thống tự động đặt tên, chọn nền tảng, thiết lập partition cô lập và mở website.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => void refreshState()} disabled={actionLoading}>
              Làm mới
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={openAccountPickerForNewBrowser}
              disabled={actionLoading}
            >
              + Mở Browser từ Account
            </button>
          </div>
        </div>

        {profiles.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748b" }}>
            Chưa có Browser Profile nào trên máy này. Nhấn <strong>"+ Mở Browser từ Account"</strong> để chọn một tài khoản từ SEO-OPS.
          </div>
        ) : (
          <div className="profile-grid">
            {profiles.map((p) => {
              const isRunning = p.status === "running";
              const boundAccount = p.accountBinding?.accountId;
              const boundName = p.accountBinding?.accountName;
              const boundEmail = p.accountBinding?.email;
              const signalOn = p.sessionSignal?.status === "present";
              const isCheckingSignal = checkingSignalId === p.browserId;
              const detectedTag = detectBrowserTagFromUrl(p.lastUrl || "");

              return (
                <div
                  key={p.browserId}
                  className={`profile-card ${isRunning ? "profile-card-active" : ""}`}
                >
                  <div className="profile-header">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="profile-title" title={boundName || boundEmail || "Chưa liên kết Account"}>
                        {boundName || boundEmail || "Chưa liên kết Account"}
                      </div>
                      <div className="profile-sub">
                        {p.platform}
                        {detectedTag !== "unknown" && (
                          <span style={{ marginLeft: 6, color: "#38bdf8" }}>• {detectedTag}</span>
                        )}
                      </div>
                    </div>
                    <span
                      className={`status-pill ${
                        isRunning ? "online" : p.status === "error" ? "error" : "offline"
                      }`}
                      style={{ fontSize: 11, padding: "2px 8px" }}
                    >
                      <span className="status-dot"></span>
                      {isRunning ? "Running" : p.status === "error" ? "Lỗi" : "Stopped"}
                    </span>
                  </div>

                  {/* Session Signal Row */}
                  <div className="profile-meta-row">
                    <span className="meta-label">Tín hiệu Session:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {signalOn ? (
                        <span
                          className="signal-pill present"
                          title={
                            p.sessionSignal?.method === "facebook_c_user_cookie"
                              ? "Phát hiện cookie c_user"
                              : "Phát hiện cookie đăng nhập WordPress"
                          }
                        >
                          ● Signal On
                        </span>
                      ) : (
                        <span className="signal-pill absent" title={p.sessionSignal?.error || "Session Signal Off"}>
                          ○ Signal Off
                        </span>
                      )}
                      <button
                        type="button"
                        className="link-action-btn"
                        onClick={() => void handleCheckSignal(p)}
                        disabled={actionLoading || isCheckingSignal}
                        title="Kiểm tra lại cookie và đồng bộ Session Signal (boolean) lên SEO-OPS."
                      >
                        {isCheckingSignal ? "⌛" : "🔄"}
                      </button>
                    </div>
                  </div>

                  {/* Execution Confirmation Row */}
                  <div className="profile-meta-row">
                    <span className="meta-label">Xác nhận chạy:</span>
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>
                      {p.executionConfirmation?.status === "confirmed" ? "Confirmed" : "Chưa chạy (not_run)"}
                    </span>
                  </div>

                  <div className="profile-actions" style={{ marginTop: 6 }}>
                    {isRunning ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: "4px 10px", fontSize: 11 }}
                          onClick={() => onOpenBrowser?.(p.browserId)}
                        >
                          💻 Đến Browser
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: "4px 10px", fontSize: 11 }}
                          onClick={handleStop}
                          disabled={actionLoading}
                        >
                          ⏹ Dừng
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        onClick={() => void handleOpen(p)}
                        disabled={actionLoading || !boundAccount}
                        title={!boundAccount ? "Chưa liên kết Account — không thể mở" : "Mở Browser"}
                      >
                        ▶ Mở Browser
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: "4px 8px", fontSize: 11, color: "#f87171" }}
                      onClick={() => void handleDelete(p)}
                      disabled={actionLoading || isRunning}
                      title={isRunning ? "Cần dừng browser trước khi xóa" : "Xóa profile (không xóa Account trên SEO-OPS)"}
                    >
                      🗑️
                    </button>
                  </div>
                  <details className="profile-technical-details">
                    <summary>Technical Details</summary>
                    <div>Browser ID: <span className="mono-subtle">{p.browserId}</span></div>
                    <div>Partition: <span className="mono-subtle">{p.partition}</span></div>
                    {boundEmail && <div>Email: {boundEmail}</div>}
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Account-First Modal: Account Picker */}
      {showAccountModal && (
        <div className="modal-backdrop">
          <div className="modal-box" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <div className="modal-title">
                {modalTargetProfile
                  ? `Liên kết Account cho: ${modalTargetProfile.accountBinding?.accountName || modalTargetProfile.accountBinding?.email || "Chưa liên kết Account"}`
                  : "Chọn Account từ SEO-OPS để tạo Browser"}
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => {
                  setShowAccountModal(false);
                  setModalTargetProfile(null);
                }}
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 12 }}>
                {modalTargetProfile
                  ? "Chọn Account để gán vào Browser Profile này. Đổi sang account khác sẽ tự động xóa session/cookies cũ để đảm bảo an toàn."
                  : "Mỗi Browser gắn liền với một Account duy nhất trên SEO-OPS. Chọn Account để tạo Browser và mở website."}
              </p>

              {loadingAccounts ? (
                <div style={{ textAlign: "center", padding: 24, color: "#94a3b8" }}>
                  Đang tải danh sách Account từ SEO-OPS...
                </div>
              ) : availableAccounts.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "24px 16px",
                    background: "#0f172a",
                    borderRadius: 8,
                    border: "1px dashed #334155",
                  }}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
                  <div style={{ fontWeight: 600, color: "#f1f5f9", marginBottom: 4 }}>
                    Chưa có Account nào trên SEO-OPS
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 12, maxWidth: 380, margin: "0 auto 12px" }}>
                    Vui lòng tạo Account trên SEO-OPS trước khi tạo Browser.
                  </div>
                </div>
              ) : (
                <div className="account-list-container">
                  {availableAccounts.map((acc) => {
                    const loginHint = (acc.email || acc.username || "").trim();
                    const existingProfile = snapshot?.profiles.find(
                      (p) => p.accountBinding?.accountId === acc.accountId
                    );
                    const isCurrentBinding = Boolean(
                      modalTargetProfile &&
                      modalTargetProfile.accountBinding?.accountId === acc.accountId
                    );

                    return (
                      <div
                        key={acc.accountId}
                        className={`account-list-item ${isCurrentBinding ? "current" : ""}`}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 600, color: "#f1f5f9" }}>
                              {acc.displayName}
                            </span>
                            <span className="mono-subtle" style={{ fontSize: 10 }}>
                              {acc.platform}
                            </span>
                          </div>

                          {loginHint ? (
                            <div style={{ fontSize: 11, color: "#38bdf8", marginTop: 2 }}>
                              👤 {loginHint}
                            </div>
                          ) : null}

                          {acc.siteUrl && (
                            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                              🌐 Site: <span className="mono-subtle">{acc.siteUrl}</span>
                            </div>
                          )}

                          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                            {acc.hasPassword ? "🔑 Đã lưu mật khẩu" : "Chưa lưu mật khẩu"}
                            {existingProfile && !modalTargetProfile && (
                              <span style={{ marginLeft: 8, color: "#34d399" }}>
                                • Đã có Profile: {existingProfile.accountBinding?.accountName || existingProfile.accountBinding?.accountId}
                              </span>
                            )}
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button
                            type="button"
                            className={`btn ${
                              isCurrentBinding
                                ? "btn-secondary"
                                : existingProfile && !modalTargetProfile
                                ? "btn-secondary"
                                : "btn-primary"
                            }`}
                            style={{ padding: "4px 10px", fontSize: 11 }}
                            disabled={actionLoading || isCurrentBinding}
                            onClick={() => void handleSelectAccount(acc)}
                          >
                            {isCurrentBinding
                              ? "Đang chọn"
                              : existingProfile && !modalTargetProfile
                              ? "Mở Profile hiện có"
                              : modalTargetProfile
                              ? "Chọn liên kết"
                              : "Tạo & Mở"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowAccountModal(false);
                  setModalTargetProfile(null);
                }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
