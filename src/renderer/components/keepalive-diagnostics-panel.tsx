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

  const enabled = diag?.enabled === true;

  return (
    <div className="card keepalive-card">
      <div className="card-title">Keep Alive 24/7 Recovery Node</div>
      <div className="card-desc">
        Durable local sync engine: Campaign snapshots + Job journal + recovery plan. Không claim
        Campaign, không ACK Server, không cần mở Browser Profile. Chỉ hiển thị dữ liệu local thật.
      </div>

      <div className="keepalive-toggle-row">
        <div className="keepalive-toggle-copy">
          <div className="form-label" style={{ marginBottom: 4 }}>
            Bật Keep Alive 24/7
          </div>
          <div className="keepalive-hint">
            Bật Node ≠ ủy quyền mọi Campaign. Chỉ Campaign được assign tường minh mới được lưu.
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
          <div className="info-label">Node</div>
          <div className="info-value">{enabled ? "Enabled" : "Disabled"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Assigned Campaigns</div>
          <div className="info-value">{diag?.assignedCampaignCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local snapshots</div>
          <div className="info-value">{diag?.campaignCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local Jobs</div>
          <div className="info-value">{diag?.jobCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last applied sequence</div>
          <div className="info-value">
            {diag?.lastAppliedSequence == null ? "—" : diag.lastAppliedSequence}
          </div>
        </div>
        <div className="info-item">
          <div className="info-label">Pending sync</div>
          <div className="info-value">{diag?.pendingSyncCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Detected gaps</div>
          <div className="info-value">{diag?.detectedGapCount ?? "—"}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Last recovery attempt</div>
          <div className="info-value">{formatTs(diag?.lastRecoveryAttemptAt ?? null)}</div>
        </div>
        <div className="info-item">
          <div className="info-label">Local sync marker</div>
          <div className="info-value">{formatTs(diag?.lastSyncAt ?? null)}</div>
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
        {diag?.storageReady ? (
          <span className="keepalive-storage-ready">
            Storage ready · no Browser · claim OFF · no fake Online/Sync
          </span>
        ) : null}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
    </div>
  );
}
