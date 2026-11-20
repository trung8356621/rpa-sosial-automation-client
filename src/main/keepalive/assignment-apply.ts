import type { CampaignAssignment } from "./contracts.js";
import type { KeepAliveServerAssignment } from "./keepalive-http-api.js";
import type { KeepAliveSqliteStore } from "./keepalive-sqlite.js";

export type AssignmentApplyOutcome = {
  applied: number;
  revoked: number;
  rejectedStale: number;
  rejectedCrossTenant: number;
};

/**
 * Apply server assignment list for one node.
 * - Does not synthesize Campaigns
 * - Revokes observation for Campaigns missing from the list (keeps historical rows)
 * - Rejects stale generation / row_version downgrades
 */
export function applyServerAssignments(
  store: KeepAliveSqliteStore,
  params: {
    nodeId: string;
    tenantId: string;
    assignments: KeepAliveServerAssignment[];
  }
): AssignmentApplyOutcome {
  const outcome: AssignmentApplyOutcome = {
    applied: 0,
    revoked: 0,
    rejectedStale: 0,
    rejectedCrossTenant: 0,
  };

  const activeKeys = new Set<string>();

  for (const row of params.assignments) {
    if (row.status === "revoked") {
      revokeObservation(store, params.tenantId, row.campaignId, params.nodeId, row);
      outcome.revoked += 1;
      continue;
    }

    const existingSameTenant = store.getAssignment(
      params.tenantId,
      row.campaignId,
      params.nodeId
    );
    if (existingSameTenant) {
      if (row.assignmentGeneration < existingSameTenant.assignmentGeneration) {
        outcome.rejectedStale += 1;
        // Still present on server list — keep observation; do not revoke as "missing".
        activeKeys.add(`${params.tenantId}::${row.campaignId}`);
        continue;
      }
      if (
        row.assignmentGeneration === existingSameTenant.assignmentGeneration &&
        row.rowVersion > 0 &&
        existingSameTenant.rowVersion > 0 &&
        row.rowVersion < existingSameTenant.rowVersion
      ) {
        outcome.rejectedStale += 1;
        activeKeys.add(`${params.tenantId}::${row.campaignId}`);
        continue;
      }
    }

    // Cross-tenant active assignment for same campaign_id on this node → revoke other tenants.
    for (const local of store.listAllAssignmentsForNode(params.nodeId)) {
      if (local.campaignId !== row.campaignId) continue;
      if (local.tenantId === params.tenantId) continue;
      if (local.status !== "assigned") continue;
      store.upsertAssignment({
        tenantId: local.tenantId,
        campaignId: local.campaignId,
        nodeId: params.nodeId,
        assignmentGeneration: Math.max(local.assignmentGeneration, row.assignmentGeneration),
        rowVersion: local.rowVersion,
        status: "revoked",
      });
      outcome.rejectedCrossTenant += 1;
      outcome.revoked += 1;
    }

    store.upsertAssignment({
      tenantId: params.tenantId,
      campaignId: row.campaignId,
      nodeId: params.nodeId,
      assignmentGeneration: row.assignmentGeneration,
      rowVersion: row.rowVersion,
      status: "assigned",
    });
    activeKeys.add(`${params.tenantId}::${row.campaignId}`);
    outcome.applied += 1;
  }

  // Missing from server list → revoke observation only (preserve history).
  for (const local of store.listAssignments(params.nodeId, "assigned")) {
    const key = `${local.tenantId}::${local.campaignId}`;
    if (activeKeys.has(key)) continue;
    // Only revoke when server list is authoritative for this tenant envelope.
    if (local.tenantId !== params.tenantId) {
      store.upsertAssignment({
        ...local,
        status: "revoked",
      });
      outcome.revoked += 1;
      continue;
    }
    store.upsertAssignment({
      ...local,
      status: "revoked",
    });
    outcome.revoked += 1;
  }

  return outcome;
}

export function revokeAllActiveAssignments(
  store: KeepAliveSqliteStore,
  nodeId: string
): number {
  let n = 0;
  for (const local of store.listAssignments(nodeId, "assigned")) {
    store.upsertAssignment({ ...local, status: "revoked" });
    n += 1;
  }
  return n;
}

function revokeObservation(
  store: KeepAliveSqliteStore,
  tenantId: string,
  campaignId: string,
  nodeId: string,
  row: KeepAliveServerAssignment
): void {
  const existing = store.getAssignment(tenantId, campaignId, nodeId);
  store.upsertAssignment({
    tenantId,
    campaignId,
    nodeId,
    assignmentGeneration: Math.max(
      row.assignmentGeneration,
      existing?.assignmentGeneration ?? 0
    ),
    rowVersion: Math.max(row.rowVersion, existing?.rowVersion ?? 0),
    status: "revoked",
    assignedAt: existing?.assignedAt,
  });
}

export function assignmentKey(a: Pick<CampaignAssignment, "tenantId" | "campaignId">): string {
  return `${a.tenantId}::${a.campaignId}`;
}
