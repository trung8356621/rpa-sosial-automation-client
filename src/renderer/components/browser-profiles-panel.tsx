import React, { useEffect, useRef, useState, useCallback } from "react";
import type { BrowserProfile, BrowserStateSnapshot } from "../../shared/contracts.js";

interface BrowserProfilesPanelProps {
  onNotify?: (msg: string) => void;
  isActiveTab: boolean;
}

export function BrowserProfilesPanel({ onNotify, isActiveTab }: BrowserProfilesPanelProps) {
  const [snapshot, setSnapshot] = useState<BrowserStateSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPlatform, setNewPlatform] = useState("facebook");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [addressInput, setAddressInput] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const data = await window.client.invoke<BrowserStateSnapshot>({ type: "getBrowserState" });
      setSnapshot(data);
    } catch {
      // ignore
    }
  }, []);

  // Update bounds of WebContentsView whenever container resizes or tab becomes active
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "createBrowserProfile",
        name: newName.trim(),
        platform: newPlatform,
      });
      setNewName("");
      setCreating(false);
      onNotify?.("Đã tạo Browser Profile mới");
      await refreshState();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRename = async (browserId: string) => {
    if (!renameValue.trim()) return;
    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "renameBrowserProfile",
        browserId,
        name: renameValue.trim(),
      });
      setRenamingId(null);
      setRenameValue("");
      onNotify?.("Đã đổi tên Profile");
      await refreshState();
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
    const ok = window.confirm(`Bạn có chắc chắn muốn xóa profile "${profile.name}"?\n(Dữ liệu chromium không bị xóa, chỉ xóa đăng ký local và SEO-OPS)`);
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

  const handleOpen = async (browserId: string) => {
    setActionLoading(true);
    try {
      await window.client.invoke({
        type: "openBrowser",
        browserId,
      });
      onNotify?.("Đã mở trình duyệt");
      await refreshState();
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

  const handleNavigate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addressInput.trim()) return;
    try {
      await window.client.invoke({
        type: "navigateBrowser",
        url: addressInput.trim(),
      });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const profiles = snapshot?.profiles ?? [];
  const activeBrowserId = snapshot?.activeBrowserId;
  const activeProfile = profiles.find((p) => p.browserId === activeBrowserId);
  const viewState = snapshot?.viewState;

  return (
    <div className="browser-page-layout">
      {/* Top Embedded Browser View Area (when active) */}
      <div className="browser-viewport-card card">
        <div className="browser-toolbar">
          <div className="nav-controls">
            <button
              type="button"
              className="browser-btn"
              disabled={!activeBrowserId || !viewState?.canGoBack}
              onClick={() => void window.client.invoke({ type: "browserGoBack" })}
              title="Quay lại"
            >
              ◀
            </button>
            <button
              type="button"
              className="browser-btn"
              disabled={!activeBrowserId || !viewState?.canGoForward}
              onClick={() => void window.client.invoke({ type: "browserGoForward" })}
              title="Tiếp theo"
            >
              ▶
            </button>
            <button
              type="button"
              className="browser-btn"
              disabled={!activeBrowserId}
              onClick={() => void window.client.invoke({ type: "browserReload" })}
              title="Tải lại"
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
              placeholder="Nhập địa chỉ URL (https://facebook.com)..."
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

        {activeProfile && (
          <div className="browser-info-bar">
            <span>
              Đang mở: <strong>{activeProfile.name}</strong> ({activeProfile.platform})
            </span>
            <span className="mono-subtle">Partition: {activeProfile.partition}</span>
          </div>
        )}

        {/* This div anchors the native WebContentsView inside Electron */}
        <div
          ref={containerRef}
          className="browser-native-container"
          style={{ height: activeBrowserId ? 380 : 180 }}
        >
          {!activeBrowserId && (
            <div className="browser-empty-placeholder">
              <div style={{ fontSize: 32, marginBottom: 8 }}>🌐</div>
              <div style={{ fontWeight: 600, color: "#cbd5e1", marginBottom: 4 }}>
                Chưa có Browser nào đang mở
              </div>
              <div style={{ color: "#64748b", maxWidth: 440, fontSize: 12 }}>
                Mỗi thiết bị chỉ mở tối đa 1 Browser tại một thời điểm. Chọn một Browser Profile bên dưới và nhấn "Mở Browser" để đăng nhập Facebook hoặc làm việc.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile Management Section */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div className="card-title">Quản lý Browser Profiles ({profiles.length})</div>
            <div className="card-desc">
              Mỗi profile sở hữu một session partition cô lập và bền vững. Đổi tên không làm mất cookies/phiên đăng nhập.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            disabled={creating}
          >
            + Tạo Profile Mới
          </button>
        </div>

        {creating && (
          <form className="create-profile-box" onSubmit={handleCreate}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Tên Profile</label>
              <input
                type="text"
                className="form-input"
                placeholder="VD: Facebook Marketing 01"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, width: 160 }}>
              <label className="form-label">Nền tảng</label>
              <select
                className="form-input"
                value={newPlatform}
                onChange={(e) => setNewPlatform(e.target.value)}
              >
                <option value="facebook">Facebook</option>
                <option value="threads">Threads</option>
                <option value="instagram">Instagram</option>
                <option value="general">Khác</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={actionLoading || !newName.trim()}>
                Lưu
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCreating(false)}
                disabled={actionLoading}
              >
                Hủy
              </button>
            </div>
          </form>
        )}

        {profiles.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 20px", color: "#64748b" }}>
            Chưa có Browser Profile nào. Nhấn "+ Tạo Profile Mới" để bắt đầu.
          </div>
        ) : (
          <div className="profile-grid">
            {profiles.map((p) => {
              const isRunning = p.status === "running";
              const isRenaming = renamingId === p.browserId;

              return (
                <div
                  key={p.browserId}
                  className={`profile-card ${isRunning ? "profile-card-active" : ""}`}
                >
                  <div className="profile-header">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {isRenaming ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            type="text"
                            className="form-input"
                            style={{ padding: "3px 6px", fontSize: 12 }}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="btn btn-primary"
                            style={{ padding: "3px 8px", fontSize: 11 }}
                            onClick={() => void handleRename(p.browserId)}
                          >
                            OK
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: "3px 8px", fontSize: 11 }}
                            onClick={() => setRenamingId(null)}
                          >
                            X
                          </button>
                        </div>
                      ) : (
                        <div className="profile-title" title={p.name}>
                          {p.name}
                        </div>
                      )}
                      <div className="profile-sub">
                        ID: <span className="mono-subtle">{p.browserId.slice(0, 8)}...</span> • {p.platform}
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

                  <div className="profile-actions">
                    {isRunning ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        onClick={handleStop}
                        disabled={actionLoading}
                      >
                        ⏹ Dừng
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        onClick={() => void handleOpen(p.browserId)}
                        disabled={actionLoading}
                      >
                        ▶ Mở Browser
                      </button>
                    )}

                    {!isRenaming && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: "4px 8px", fontSize: 11 }}
                        onClick={() => {
                          setRenamingId(p.browserId);
                          setRenameValue(p.name);
                        }}
                        disabled={actionLoading}
                        title="Đổi tên profile"
                      >
                        ✏️ Sửa tên
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: "4px 8px", fontSize: 11, color: "#f87171" }}
                      onClick={() => void handleDelete(p)}
                      disabled={actionLoading || isRunning}
                      title={isRunning ? "Cần dừng browser trước khi xóa" : "Xóa profile"}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
