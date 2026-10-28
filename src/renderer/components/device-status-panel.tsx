import React, { useState } from "react";
import type { ConnectionState } from "../../shared/contracts.js";

interface Props {
  state: ConnectionState;
  onUpdate: () => void;
}

export function DeviceStatusPanel({ state, onUpdate }: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(state.device?.displayName || "");
  const [busy, setBusy] = useState(false);

  const device = state.device;
  const shortDeviceId = device?.deviceId
    ? device.deviceId.length > 20
      ? `${device.deviceId.slice(0, 12)}...${device.deviceId.slice(-6)}`
      : device.deviceId
    : "—";

  async function handleSaveName() {
    if (!nameInput.trim()) return;
    setBusy(true);
    try {
      await window.client.invoke({ type: "setDisplayName", displayName: nameInput.trim() });
      setEditingName(false);
      onUpdate();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function handleTriggerHeartbeat() {
    setBusy(true);
    try {
      await window.client.invoke({ type: "triggerHeartbeat" });
      onUpdate();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-title">
        <span>Thông tin thiết bị (Device Identity)</span>
        {state.status === "connected" && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: "4px 8px" }}
            disabled={busy}
            onClick={handleTriggerHeartbeat}
          >
            Gửi Heartbeat ngay
          </button>
        )}
      </div>
      <div className="card-desc">
        Mỗi máy trạm cài đặt RPA Client sở hữu một Device ID ngẫu nhiên, không thay đổi sau khi tạo.
      </div>

      <div className="info-grid">
        <div className="info-item">
          <div className="info-label">Tên hiển thị</div>
          {editingName ? (
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <input
                type="text"
                className="text-input"
                style={{ padding: "4px 8px", fontSize: 12 }}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "4px 8px", fontSize: 11 }}
                disabled={busy}
                onClick={handleSaveName}
              >
                Lưu
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: "4px 8px", fontSize: 11 }}
                onClick={() => setEditingName(false)}
              >
                Hủy
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="info-value">{device?.displayName || "—"}</span>
              <button
                type="button"
                style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: 11 }}
                onClick={() => {
                  setNameInput(device?.displayName || "");
                  setEditingName(true);
                }}
              >
                Đổi tên
              </button>
            </div>
          )}
        </div>

        <div className="info-item">
          <div className="info-label">Device ID</div>
          <div className="info-value" title={device?.deviceId}>
            {shortDeviceId}
          </div>
        </div>

        <div className="info-item">
          <div className="info-label">Hệ điều hành / Nền tảng</div>
          <div className="info-value">{device?.osLabel || device?.osVersion || "—"}</div>
        </div>

        <div className="info-item">
          <div className="info-label">Phiên bản Client</div>
          <div className="info-value">v{device?.clientVersion || "0.1.0"}</div>
        </div>

        <div className="info-item">
          <div className="info-label">SEO-OPS Agent UUID</div>
          <div className="info-value">{state.agentUuid || "Chưa đăng ký"}</div>
        </div>

        <div className="info-item">
          <div className="info-label">Lần Heartbeat gần nhất</div>
          <div className="info-value">
            {state.lastHeartbeatAt
              ? new Date(state.lastHeartbeatAt).toLocaleTimeString()
              : "Chưa gửi"}
          </div>
        </div>
      </div>
    </div>
  );
}
