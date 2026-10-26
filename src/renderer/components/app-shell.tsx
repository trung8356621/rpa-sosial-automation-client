import React, { useEffect, useState } from "react";
import type { ConnectionState } from "../../shared/contracts.js";
import { DeviceStatusPanel } from "./device-status-panel.js";
import { ConnectionSettingsPanel } from "./connection-settings-panel.js";

type Tab = "status" | "settings" | "logs";

interface LogEntry {
  time: string;
  level: string;
  message: string;
}

export function AppShell() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("status");
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const refreshState = async () => {
    try {
      const next = await window.client.invoke<ConnectionState>({ type: "getConnectionState" });
      setState(next);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshState();

    const unsubState = window.client.onStateChange((next) => {
      setState(next);
    });

    const unsubLog = window.client.onLog((entry) => {
      setLogs((prev) => [entry, ...prev.slice(0, 99)]);
    });

    return () => {
      unsubState();
      unsubLog();
    };
  }, []);

  if (!state) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
        Đang khởi động RPA Client...
      </div>
    );
  }

  const isOnline = state.status === "connected" && state.online;
  const isConnecting = state.status === "connecting";

  return (
    <>
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon">RC</div>
          <div>
            <div className="brand-title">RPA Client V2</div>
            <div className="brand-subtitle">Execution Agent</div>
          </div>
        </div>

        <div className="header-actions">
          <div
            className={`status-pill ${
              isOnline ? "online" : isConnecting ? "connecting" : state.status === "error" ? "error" : "offline"
            }`}
          >
            <span className="status-dot"></span>
            {isOnline
              ? "Online"
              : isConnecting
                ? "Đang kết nối..."
                : state.status === "error"
                  ? "Lỗi kết nối"
                  : "Offline"}
          </div>
        </div>
      </header>

      <div className="app-body">
        <aside className="nav-sidebar">
          <button
            type="button"
            className={`nav-item ${activeTab === "status" ? "active" : ""}`}
            onClick={() => setActiveTab("status")}
          >
            🖥️ Trạng thái thiết bị
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            ⚙️ Cấu hình kết nối
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
          >
            📋 Nhật ký hoạt động
          </button>
        </aside>

        <main className="main-content">
          {activeTab === "status" && (
            <>
              <DeviceStatusPanel state={state} onUpdate={refreshState} />
              <ConnectionSettingsPanel state={state} onUpdate={refreshState} />
            </>
          )}

          {activeTab === "settings" && (
            <ConnectionSettingsPanel state={state} onUpdate={refreshState} />
          )}

          {activeTab === "logs" && (
            <div className="card">
              <div className="card-title">Nhật ký hoạt động (Client Logs)</div>
              <div className="card-desc">
                Nhật ký vận hành cục bộ. Thông tin bảo mật (API Key) được lọc tự động trước khi ghi.
              </div>
              <div className="log-card" style={{ maxHeight: 420 }}>
                {logs.length === 0 ? (
                  <div style={{ color: "#475569" }}>Chưa có log mới</div>
                ) : (
                  logs.map((l, i) => (
                    <div key={i} className={`log-entry ${l.level}`}>
                      <span style={{ color: "#64748b" }}>[{l.time.slice(11, 19)}]</span> {l.message}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Quick preview log box on status tab */}
          {activeTab === "status" && logs.length > 0 && (
            <div className="card">
              <div className="card-title" style={{ fontSize: 13 }}>
                Nhật ký gần đây
              </div>
              <div className="log-card">
                {logs.slice(0, 5).map((l, i) => (
                  <div key={i} className={`log-entry ${l.level}`}>
                    <span style={{ color: "#64748b" }}>[{l.time.slice(11, 19)}]</span> {l.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
