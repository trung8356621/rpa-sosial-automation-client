import React, { useCallback, useEffect, useState } from "react";
import type { ConnectionState, WindowsNotificationStatus } from "../../shared/contracts.js";
import { APP_USER_MODEL_ID } from "../../shared/windows-notification.js";

interface Props {
  state: ConnectionState;
  onUpdate: () => void;
}

export function ConnectionSettingsPanel({ state, onUpdate }: Props) {
  const [endpoint, setEndpoint] = useState(state.endpoint || "https://seo-ops.test");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [notifStatus, setNotifStatus] = useState<WindowsNotificationStatus | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);

  const isConnected = state.status === "connected";

  const refreshNotificationStatus = useCallback(async () => {
    setNotifBusy(true);
    try {
      const next = await window.client.invoke<WindowsNotificationStatus>({
        type: "getWindowsNotificationStatus",
      });
      setNotifStatus(next);
    } catch {
      setNotifStatus({
        status: "Blocked",
        setting: "Unverified",
        verified: false,
        reason: "Không xác minh được quyền",
        appUserModelId: APP_USER_MODEL_ID,
      });
    } finally {
      setNotifBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshNotificationStatus();
    const unsub = window.client.onWindowsNotificationStatus((next) => {
      setNotifStatus(next);
    });
    return unsub;
  }, [refreshNotificationStatus]);

  async function handleOpenWindowsSettings() {
    setNotifBusy(true);
    try {
      await window.client.invoke({ type: "openWindowsNotificationSettings" });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setNotifBusy(false);
    }
  }

  async function handleSaveEndpoint() {
    setBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await window.client.invoke({ type: "setEndpoint", endpoint });
      setActionSuccess("Đã lưu endpoint thành công.");
      onUpdate();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setActionError("Vui lòng nhập API Key.");
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await window.client.invoke({ type: "connect", apiKey, endpoint });
      setApiKey("");
      setActionSuccess("Kết nối thành công tới SEO-OPS!");
      onUpdate();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await window.client.invoke({ type: "disconnect" });
      setActionSuccess("Đã ngắt kết nối.");
      onUpdate();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusLabel =
    state.status === "connected"
      ? state.online
        ? "Đã kết nối (Online)"
        : "Đã kết nối"
      : state.status === "connecting"
        ? "Đang kết nối..."
        : state.status === "error"
          ? "Lỗi kết nối"
          : "Chưa kết nối";

  return (
    <div className="card">
      <div className="card-title">Cấu hình kết nối SEO-OPS</div>
      <div className="card-desc">
        Kết nối RPA Client với hệ thống SEO-OPS qua Endpoint và Client API Key.
      </div>
      <div
        className={`connection-status-banner ${
          state.status === "connected" ? "ok" : state.status === "connecting" ? "pending" : "locked"
        }`}
        role="status"
      >
        Trạng thái: <strong>{statusLabel}</strong>
        {state.keyPrefix ? ` · Key ${state.keyPrefix}` : ""}
      </div>

      <div className="form-group">
        <label className="form-label">SEO-OPS Endpoint</label>
        <div className="input-row">
          <input
            type="text"
            className="text-input"
            value={endpoint}
            disabled={busy || isConnected}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://seo-ops.test"
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || isConnected || endpoint === state.endpoint}
            onClick={handleSaveEndpoint}
          >
            Lưu endpoint
          </button>
        </div>
      </div>

      {isConnected ? (
        <div className="form-group">
          <div className="info-grid">
            <div className="info-item">
              <div className="info-label">Installation ID</div>
              <div className="info-value">{state.installation?.installationId || "—"}</div>
            </div>
            <div className="info-item">
              <div className="info-label">Client API Key Prefix</div>
              <div className="info-value">{state.keyPrefix || "••••••••"}</div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={handleDisconnect}
            >
              {busy ? "Đang xử lý..." : "Ngắt kết nối (Disconnect)"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnect}>
          <div className="form-group">
            <label className="form-label">Client API Key</label>
            <div className="password-container">
              <input
                type={showKey ? "text" : "password"}
                className="text-input"
                value={apiKey}
                disabled={busy}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="rpa_client_••••••••"
              />
              <button
                type="button"
                className="btn-toggle-pw"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? "Ẩn" : "Hiện"}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !apiKey.trim()}
          >
            {busy ? "Đang kết nối..." : "Kết nối (Connect)"}
          </button>
        </form>
      )}

      {actionError && <div className="alert alert-error">{actionError}</div>}
      {state.lastError && !actionError && (
        <div className="alert alert-error">{state.lastError}</div>
      )}
      {actionSuccess && <div className="alert alert-success">{actionSuccess}</div>}

      <div className="windows-notif-section">
        <div className="form-label">Windows Notifications</div>
        <div className="windows-notif-row">
          <div className="windows-notif-status-wrap">
            <span className="windows-notif-status-label">Status:</span>
            {notifStatus ? (
              <span
                className={`windows-notif-badge ${
                  notifStatus.status === "Allowed" ? "allowed" : "blocked"
                }`}
              >
                {notifStatus.status}
              </span>
            ) : (
              <span className="windows-notif-badge blocked">Blocked</span>
            )}
            {notifStatus?.reason && (
              <span className="windows-notif-reason">{notifStatus.reason}</span>
            )}
          </div>
          <div className="windows-notif-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={notifBusy}
              onClick={() => void handleOpenWindowsSettings()}
            >
              Open Windows Settings
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={notifBusy}
              onClick={() => void refreshNotificationStatus()}
              title="Làm mới trạng thái"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
