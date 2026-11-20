import React, { useCallback, useEffect, useState } from "react";
import type { KeepAliveDiagnostics } from "../../shared/contracts.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function registrationLabel(status: KeepAliveDiagnostics["registrationStatus"] | undefined): string {
  switch (status) {
    case "registered":
      return "Registered";
    case "auth_blocked":
      return "Auth blocked";
    case "protocol_mismatch":
      return "Protocol mismatch";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
    default:
      return "Idle";
  }
}

export function KeepAliveDiagnosticsPanel() {
  const [diag, setDiag] = useState<KeepAliveDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.client.invoke<KeepAliveDiagnostics>({
        type: "getKeepAliveDiagnostics",
      });
      setDiag(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được Keep Alive diagnostics.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleToggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await window.client.invoke<KeepAliveDiagnostics>({
        type: "setKeepAliveEnabled",
        enabled,
      });
      setDiag(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được cấu hình Keep Alive.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshAssignments() {
    setBusy(true);
    setError(null);
    try {
      const next = await window.client.invoke<KeepAliveDiagnostics>({
        type: "refreshKeepAliveAssignments",
      });
      setDiag(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không refresh được assignments.");
    } finally {
      setBusy(false);
    }
  }

  const enabled = diag?.enabled === true;

  return (
    <div className="card keepalive-card">
      <div className="card-title">Keep Alive 24/7 Recovery Node</div>
      <div className="card-desc">
        Đăng ký Node + nhận Campaign assignment (keepalive.v1). Không claim Job, không ACK execute,
        không cần Browser. Snapshot sync chưa triển khai — không giả lập đồng bộ thành công.
      </div>

      <div className="keepalive-toggle-row">
        <div className="keepalive-toggle-copy">
          <div className="form-label" style={{ marginBottom: 4 }}>
            Bật Keep Alive 24/7
          </div>
          <div className="keepalive-hint">
            Bật Node ≠ ủy quyền mọi Campaign. Chỉ assignment tường minh từ Server được áp dụng.
          </div>
        </div>
        <label className="keepalive-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !diag}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          <span className="keepalive-switch-slider" />
          <span className="keepalive-switch-label">{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      <div className="info-grid keepalive-diag-grid">
        <div className="info-item">
          <div className="info-label">Node enabled</div>
          <div className="info-value">{enabled ? "Yes" : "No"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Registration</div>
          <div className="info-value">{registrationLabel(diag?.registrationStatus)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Server registration</div>
          <div className="info-value">
            {diag?.serverRegistrationConfirmed ? "Confirmed" : "Not confirmed"}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Assignment confirmed</div>
          <div className="info-value">
            {diag?.campaignAssignmentConfirmed ? "Yes" : "No"}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Server assignments</div>
          <div className="info-value">
            {diag?.serverAssignmentCount == null ? "—" : diag.serverAssignmentCount}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Local assigned</div>
          <div className="info-value">{diag?.assignedCampaignCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local data available</div>
          <div className="info-value">{diag?.localDataAvailable ? "Yes" : "No"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Snapshot sync</div>
          <div className="info-value">Not implemented</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last assignment refresh</div>
          <div className="info-value">{formatTs(diag?.lastAssignmentRefreshAt ?? null)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last HTTP error</div>
          <div className="info-value">{diag?.lastHttpError || "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Storage health</div>
          <div className="info-value">{diag?.storageHealth ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local storage</div>
          <div className="info-value">{diag ? formatBytes(diag.storageBytes) : "—"}</div>
        </div>
      </div>

      <div className="keepalive-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh diagnostics
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !enabled}
          onClick={() => void handleRefreshAssignments()}
        >
          Refresh assignments
        </button>
        {diag?.storageReady ? (
          <span className="keepalive-storage-ready">
            Storage ready · no Browser · claim OFF · snapshot sync N/A
          </span>
        ) : null}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
    </div>
  );
}
