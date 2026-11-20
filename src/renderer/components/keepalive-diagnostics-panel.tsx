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

function snapshotLabel(status: KeepAliveDiagnostics["snapshotSyncStatus"] | undefined): string {
  switch (status) {
    case "synced":
      return "Local synced";
    case "partial":
      return "Partial";
    case "syncing":
      return "Syncing";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    default:
      return "Not started";
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
        HTTP + SQLite durable sync; Socket.IO hints only (keepalive.v1). Không claim Job, không
        Browser. Local applied ≠ server ACK. Socket hints ≠ Sync PASS.
      </div>

      <div className="keepalive-toggle-row">
        <div className="keepalive-toggle-copy">
          <div className="form-label" style={{ marginBottom: 4 }}>
            Bật Keep Alive 24/7
          </div>
          <div className="keepalive-hint">
            Chỉ Campaign được Server assign tường minh mới được fetch snapshot/events.
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
          <div className="info-label">Registration</div>
          <div className="info-value">{registrationLabel(diag?.registrationStatus)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Snapshot sync</div>
          <div className="info-value">{snapshotLabel(diag?.snapshotSyncStatus)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local applied sequence</div>
          <div className="info-value">
            {diag?.lastSyncedSequence == null && diag?.lastAppliedSequence == null
              ? "—"
              : (diag?.lastSyncedSequence ?? diag?.lastAppliedSequence)}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Server ACK sequence</div>
          <div className="info-value">
            {diag?.lastServerAckSequence == null ? "—" : diag.lastServerAckSequence}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Pending ACK</div>
          <div className="info-value">{diag?.pendingAckCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last ACK success</div>
          <div className="info-value">{formatTs(diag?.lastAckSuccessAt ?? null)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last ACK error</div>
          <div className="info-value">{diag?.lastAckError || "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Artifact ACK</div>
          <div className="info-value">
            {diag?.artifactAckState ?? "idle"}
            {diag?.artifactAckPendingCount ? ` · pending ${diag.artifactAckPendingCount}` : ""}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Event gaps</div>
          <div className="info-value">{diag?.detectedGapCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Pending recovery</div>
          <div className="info-value">{diag?.pendingRecovery ? "Yes" : "No"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last successful sync</div>
          <div className="info-value">{formatTs(diag?.lastSuccessfulSyncAt ?? null)}</div>
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
          <div className="info-label">Server durable ACK</div>
          <div className="info-value">{diag?.serverDurableAck ? "Confirmed" : "None yet"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Socket</div>
          <div className="info-value">
            {diag?.socketConnected
              ? "Connected"
              : (diag?.socketStatus ?? "idle")}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Last socket notify</div>
          <div className="info-value">{formatTs(diag?.lastSocketNotifyAt ?? null)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Socket reconnects</div>
          <div className="info-value">{diag?.socketReconnectAttempts ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Route generation</div>
          <div className="info-value">
            {diag?.socketRouteGeneration == null ? "—" : diag.socketRouteGeneration}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Last socket error</div>
          <div className="info-value">{diag?.lastSocketError || "—"}</div>
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
          Refresh sync
        </button>
        {diag?.storageReady ? (
          <span className="keepalive-storage-ready">
            Storage ready · no Browser · claim OFF · socket hints on
          </span>
        ) : null}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
    </div>
  );
}
