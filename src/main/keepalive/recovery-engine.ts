import { randomUUID } from "node:crypto";
import type {
  CampaignRecoveryState,
  RecoveryPlan,
  RecoveryRequest,
  SequenceGap,
} from "./contracts.js";
import { countGaps, type KeepAliveSqliteStore } from "./keepalive-sqlite.js";

/**
 * Build a local recovery plan after Client restart.
 *
 * - Loads assigned Campaign snapshots / cursors
 * - Detects missing sequence ranges
 * - Lists pending sync + screenshot evidence metadata
 * - Prepares fetch/ack requests WITHOUT sending them
 * - Does not replay social actions
 * - Preserves local rows until durable acknowledgement (no deletes)
 */
export function prepareRecovery(store: KeepAliveSqliteStore, nodeId: string): RecoveryPlan {
  const startedAt = new Date().toISOString();
  const recoveryId = randomUUID();
  const assignments = store.listAssignments(nodeId, "assigned");
  const campaigns: CampaignRecoveryState[] = [];
  const requests: RecoveryRequest[] = [];

  for (const assignment of assignments) {
    const { tenantId, campaignId } = assignment;
    const cursor = store.getCursor(tenantId, campaignId);
    const sequences = store.listJournalSequences(tenantId, campaignId);
    const lastSeenSequence = Math.max(
      cursor?.lastSeenSequence ?? 0,
      sequences.length ? Math.max(...sequences) : 0
    );
    const lastAppliedSequence = cursor?.lastAppliedSequence ?? 0;

    const rawGaps = countGaps(sequences, lastSeenSequence);
    const gaps: SequenceGap[] = rawGaps.map((g) => ({
      tenantId,
      campaignId,
      fromSequence: g.from,
      toSequence: g.to,
    }));

    // Also treat hole between lastApplied+1 and next applied presence as recovery need
    // when buffered events exist beyond applied.
    if (lastAppliedSequence < lastSeenSequence) {
      const covered = new Set(
        gaps.flatMap((g) => {
          const out: number[] = [];
          for (let i = g.fromSequence; i <= g.toSequence; i++) out.push(i);
          return out;
        })
      );
      for (let seq = lastAppliedSequence + 1; seq <= lastSeenSequence; seq++) {
        if (!sequences.includes(seq) && !covered.has(seq)) {
          // extend or add gap
          const last = gaps[gaps.length - 1];
          if (last && last.toSequence === seq - 1) {
            last.toSequence = seq;
          } else {
            gaps.push({ tenantId, campaignId, fromSequence: seq, toSequence: seq });
          }
        }
      }
    }

    const pendingSync = store.listPendingSyncEvents(tenantId, campaignId);
    const pendingShots = store.listPendingScreenshots(tenantId, campaignId);

    campaigns.push({
      tenantId,
      campaignId,
      lastAppliedSequence,
      lastSeenSequence,
      gaps,
      pendingSyncEventIds: pendingSync.map((e) => e.eventId),
      pendingScreenshotIds: pendingShots.map((s) => s.id),
    });

    if (!store.getSnapshot(tenantId, campaignId)) {
      requests.push({
        type: "fetch_campaign_snapshot",
        tenantId,
        campaignId,
        preparedOnly: true,
      });
    }

    for (const gap of gaps) {
      requests.push({
        type: "fetch_event_sequences",
        tenantId,
        campaignId,
        fromSequence: gap.fromSequence,
        toSequence: gap.toSequence,
        preparedOnly: true,
      });
    }

    if (pendingSync.length > 0 || pendingShots.length > 0) {
      requests.push({
        type: "ack_pending_sync",
        tenantId,
        campaignId,
        preparedOnly: true,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const plan: RecoveryPlan = {
    recoveryId,
    startedAt,
    finishedAt,
    status: "prepared",
    assignedCampaigns: assignments.length,
    campaigns,
    requests,
    replaySocialActions: false,
  };

  store.saveRecoveryRun(recoveryId, startedAt, finishedAt, JSON.stringify(plan));
  store.markRecoveryAttempt(finishedAt, recoveryId);
  // Preserve all local journal/snapshot/screenshot rows — no purge on recovery.
  return plan;
}
