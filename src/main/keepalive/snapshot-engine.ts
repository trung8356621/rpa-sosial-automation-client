import {
  SENSITIVE_SNAPSHOT_KEYS,
  type CampaignSnapshotInput,
  type CampaignSnapshotRecord,
  type SnapshotUpsertResult,
} from "./contracts.js";
import type { KeepAliveSqliteStore } from "./keepalive-sqlite.js";

function containsSensitiveKeys(value: unknown, path = ""): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = containsSensitiveKeys(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    if ((SENSITIVE_SNAPSHOT_KEYS as readonly string[]).includes(normalized)) {
      return path ? `${path}.${key}` : key;
    }
    const hit = containsSensitiveKeys(child, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

export function validateSnapshotInput(input: CampaignSnapshotInput): SnapshotUpsertResult | null {
  if (!input.tenantId?.trim() || !input.campaignId?.trim()) {
    return { ok: false, reason: "invalid", message: "tenant_id and campaign_id are required" };
  }
  if (!Number.isInteger(input.snapshotVersion) || input.snapshotVersion < 1) {
    return { ok: false, reason: "invalid", message: "snapshot_version must be a positive integer" };
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    return { ok: false, reason: "invalid", message: "sequence must be a non-negative integer" };
  }
  if (!Number.isInteger(input.assignmentGeneration) || input.assignmentGeneration < 1) {
    return {
      ok: false,
      reason: "invalid",
      message: "assignment_generation must be a positive integer",
    };
  }
  if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    return { ok: false, reason: "invalid", message: "metadata must be a non-array object" };
  }
  const sensitive = containsSensitiveKeys(input.metadata);
  if (sensitive) {
    return {
      ok: false,
      reason: "sensitive_payload",
      message: `Snapshot metadata must not include secrets (${sensitive})`,
    };
  }
  return null;
}

/**
 * Upsert a versioned tenant-scoped Campaign snapshot.
 * Requires an active assignment for this node — Keep Alive enabled ≠ all Campaigns.
 */
export function upsertCampaignSnapshot(
  store: KeepAliveSqliteStore,
  nodeId: string,
  input: CampaignSnapshotInput
): SnapshotUpsertResult {
  const invalid = validateSnapshotInput(input);
  if (invalid) return invalid;

  const assignment = store.getAssignment(input.tenantId, input.campaignId, nodeId);
  if (!assignment || assignment.status !== "assigned") {
    return {
      ok: false,
      reason: "unauthorized",
      message: "Campaign is not assigned to this Keep Alive node",
    };
  }

  if (input.assignmentGeneration < assignment.assignmentGeneration) {
    return {
      ok: false,
      reason: "stale",
      message: "Snapshot assignment_generation is older than local assignment",
    };
  }

  const existing = store.getSnapshot(input.tenantId, input.campaignId);
  if (existing) {
    if (existing.tenantId !== input.tenantId) {
      return { ok: false, reason: "tenant_mismatch", message: "Tenant mismatch for Campaign snapshot" };
    }
    if (input.sequence < existing.sequence) {
      return { ok: false, reason: "stale", message: "Snapshot sequence is older than local snapshot" };
    }
    if (input.sequence === existing.sequence && input.snapshotVersion < existing.snapshotVersion) {
      return {
        ok: false,
        reason: "stale",
        message: "Snapshot version is older than local snapshot at same sequence",
      };
    }
    if (input.assignmentGeneration < existing.assignmentGeneration) {
      return {
        ok: false,
        reason: "stale",
        message: "Snapshot assignment_generation is older than stored snapshot",
      };
    }
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const record: CampaignSnapshotRecord = {
    tenantId: input.tenantId.trim(),
    campaignId: input.campaignId.trim(),
    snapshotVersion: input.snapshotVersion,
    sequence: input.sequence,
    assignmentGeneration: input.assignmentGeneration,
    updatedAt,
    metadata: input.metadata,
    metadataJson: JSON.stringify(input.metadata),
  };

  store.insertSnapshot(record);
  return { ok: true, snapshot: record };
}
