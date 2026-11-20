import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientStore } from "../src/main/storage/store.js";
import { KeepAliveNodeService } from "../src/main/keepalive/keepalive-node.js";
import type { JobEventType } from "../src/main/keepalive/contracts.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-p2-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function bootNode(dir: string, nodeKey?: string): Promise<{
  settings: ClientStore;
  node: KeepAliveNodeService;
}> {
  const settings = new ClientStore(dir);
  await settings.load();
  if (nodeKey) await settings.set({ keepAliveNodeId: nodeKey });
  const node = new KeepAliveNodeService(dir, settings);
  await node.initialize();
  await node.setEnabled(true);
  return { settings, node };
}

function baseEvent(
  overrides: Partial<{
    eventId: string;
    tenantId: string;
    campaignId: string;
    jobId: string;
    attempt: number;
    fencingGeneration: number;
    eventSequence: number;
    eventType: JobEventType;
  }> = {}
) {
  return {
    eventId: overrides.eventId ?? "evt-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    campaignId: overrides.campaignId ?? "camp-1",
    jobId: overrides.jobId ?? "job-1",
    attempt: overrides.attempt ?? 1,
    fencingGeneration: overrides.fencingGeneration ?? 1,
    eventSequence: overrides.eventSequence ?? 1,
    eventType: overrides.eventType ?? ("job_started" as JobEventType),
  };
}

test("snapshot upsert succeeds for assigned Campaign; rejects stale and sensitive", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 2,
    });

    const ok = await node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      snapshotVersion: 1,
      sequence: 10,
      assignmentGeneration: 2,
      metadata: { name: "Seeding", platform: "wordpress" },
    });
    assert.equal(ok.ok, true);

    const staleSeq = await node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      snapshotVersion: 2,
      sequence: 9,
      assignmentGeneration: 2,
      metadata: { name: "older" },
    });
    assert.equal(staleSeq.ok, false);
    if (!staleSeq.ok) assert.equal(staleSeq.reason, "stale");

    const sensitive = await node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      snapshotVersion: 3,
      sequence: 11,
      assignmentGeneration: 2,
      metadata: { name: "x", cookies: { c_user: "secret" } },
    });
    assert.equal(sensitive.ok, false);
    if (!sensitive.ok) assert.equal(sensitive.reason, "sensitive_payload");

    node.destroy();
  });
});

test("enabling Keep Alive does not authorize unassigned Campaigns", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    const snap = await node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-unassigned",
      snapshotVersion: 1,
      sequence: 1,
      assignmentGeneration: 1,
      metadata: { name: "nope" },
    });
    assert.equal(snap.ok, false);
    if (!snap.ok) assert.equal(snap.reason, "unauthorized");

    const evt = await node.ingestJobEvent(baseEvent({ campaignId: "camp-unassigned" }));
    assert.equal(evt.ok, false);
    if (!evt.ok) assert.equal(evt.status, "rejected_unauthorized");
    node.destroy();
  });
});

test("multiple Campaign assignments on one Node", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({ tenantId: "t1", campaignId: "c1", assignmentGeneration: 1 });
    await node.assignCampaign({ tenantId: "t1", campaignId: "c2", assignmentGeneration: 1 });

    assert.equal(
      (
        await node.upsertCampaignSnapshot({
          tenantId: "t1",
          campaignId: "c1",
          snapshotVersion: 1,
          sequence: 1,
          assignmentGeneration: 1,
          metadata: { title: "A" },
        })
      ).ok,
      true
    );
    assert.equal(
      (
        await node.upsertCampaignSnapshot({
          tenantId: "t1",
          campaignId: "c2",
          snapshotVersion: 1,
          sequence: 1,
          assignmentGeneration: 1,
          metadata: { title: "B" },
        })
      ).ok,
      true
    );

    const diag = await node.getDiagnostics();
    assert.equal(diag.assignedCampaignCount, 2);
    assert.equal(diag.campaignCount, 2);
    node.destroy();
  });
});

test("multiple 24/7 Nodes can hold the same Campaign independently", async () => {
  await withTempDir(async (dirA) => {
    await withTempDir(async (dirB) => {
      const a = await bootNode(dirA, "node-A");
      const b = await bootNode(dirB, "node-B");

      await a.node.assignCampaign({
        tenantId: "tenant-a",
        campaignId: "shared-camp",
        assignmentGeneration: 1,
      });
      await b.node.assignCampaign({
        tenantId: "tenant-a",
        campaignId: "shared-camp",
        assignmentGeneration: 1,
      });

      assert.equal(
        (
          await a.node.upsertCampaignSnapshot({
            tenantId: "tenant-a",
            campaignId: "shared-camp",
            snapshotVersion: 1,
            sequence: 5,
            assignmentGeneration: 1,
            metadata: { node: "A" },
          })
        ).ok,
        true
      );
      assert.equal(
        (
          await b.node.upsertCampaignSnapshot({
            tenantId: "tenant-a",
            campaignId: "shared-camp",
            snapshotVersion: 1,
            sequence: 7,
            assignmentGeneration: 1,
            metadata: { node: "B" },
          })
        ).ok,
        true
      );

      assert.equal(a.node.getNodeId(), "node-A");
      assert.equal(b.node.getNodeId(), "node-B");
      assert.equal(
        a.node.sqlite.getSnapshot("tenant-a", "shared-camp")?.metadata.node,
        "A"
      );
      assert.equal(
        b.node.sqlite.getSnapshot("tenant-a", "shared-camp")?.metadata.node,
        "B"
      );

      a.node.destroy();
      b.node.destroy();
    });
  });
});

test("duplicate event_id is idempotent", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });

    const first = await node.ingestJobEvent(baseEvent({ eventId: "dup", eventSequence: 1 }));
    const second = await node.ingestJobEvent(
      baseEvent({ eventId: "dup", eventSequence: 1, eventType: "job_completed" })
    );
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.status, "applied");
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.status, "duplicate");
    assert.equal(node.sqlite.getJournalEvent("dup")?.eventType, "job_started");
    node.destroy();
  });
});

test("out-of-order events buffer; contiguous apply drains; gaps detected", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });

    const third = await node.ingestJobEvent(
      baseEvent({ eventId: "e3", eventSequence: 3, eventType: "job_completed" })
    );
    assert.equal(third.ok, true);
    if (third.ok) assert.equal(third.status, "buffered");

    const first = await node.ingestJobEvent(
      baseEvent({ eventId: "e1", eventSequence: 1, eventType: "job_reserved" })
    );
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.status, "applied");

    // Still missing 2 → 3 remains buffered
    assert.equal(node.sqlite.getJournalEvent("e3")?.applyStatus, "buffered");
    assert.equal(node.sqlite.getCursor("tenant-a", "camp-1")?.lastAppliedSequence, 1);

    const second = await node.ingestJobEvent(
      baseEvent({ eventId: "e2", eventSequence: 2, eventType: "job_claimed" })
    );
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.status, "applied");
    assert.equal(node.sqlite.getJournalEvent("e3")?.applyStatus, "applied");
    assert.equal(node.sqlite.getCursor("tenant-a", "camp-1")?.lastAppliedSequence, 3);

    // Create a gap by buffering 5 without 4
    await node.ingestJobEvent(
      baseEvent({ eventId: "e5", eventSequence: 5, eventType: "job_failed" })
    );
    const plan = await node.runRecovery();
    const camp = plan.campaigns.find((c) => c.campaignId === "camp-1");
    assert.ok(camp);
    assert.ok(camp.gaps.some((g) => g.fromSequence <= 4 && g.toSequence >= 4));
    assert.equal(plan.replaySocialActions, false);
    assert.ok(plan.requests.every((r) => r.preparedOnly === true));

    const diag = await node.getDiagnostics();
    assert.ok((diag.detectedGapCount ?? 0) >= 1);
    node.destroy();
  });
});

test("fencing and older attempt cannot overwrite newer state", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });

    assert.equal(
      (
        await node.ingestJobEvent(
          baseEvent({
            eventId: "f1",
            eventSequence: 1,
            attempt: 2,
            fencingGeneration: 3,
            eventType: "job_started",
          })
        )
      ).ok,
      true
    );

    const staleFence = await node.ingestJobEvent(
      baseEvent({
        eventId: "f2",
        eventSequence: 2,
        attempt: 9,
        fencingGeneration: 2,
        eventType: "job_completed",
      })
    );
    assert.equal(staleFence.ok, false);
    if (!staleFence.ok) assert.equal(staleFence.status, "rejected_stale");

    const staleAttempt = await node.ingestJobEvent(
      baseEvent({
        eventId: "f3",
        eventSequence: 2,
        attempt: 1,
        fencingGeneration: 3,
        eventType: "job_failed",
      })
    );
    assert.equal(staleAttempt.ok, false);
    if (!staleAttempt.ok) assert.equal(staleAttempt.status, "rejected_stale");

    const state = node.sqlite.getJobState("tenant-a", "camp-1", "job-1");
    assert.equal(state?.fencingGeneration, 3);
    assert.equal(state?.attempt, 2);
    node.destroy();
  });
});

test("tenant isolation rejects mismatched Campaign data", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });
    await node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      snapshotVersion: 1,
      sequence: 1,
      assignmentGeneration: 1,
      metadata: { name: "A" },
    });

    // Different tenant, same campaign id, not assigned → unauthorized
    const other = await node.upsertCampaignSnapshot({
      tenantId: "tenant-b",
      campaignId: "camp-1",
      snapshotVersion: 1,
      sequence: 2,
      assignmentGeneration: 1,
      metadata: { name: "B" },
    });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.reason, "unauthorized");

    const evt = await node.ingestJobEvent(
      baseEvent({ tenantId: "tenant-b", campaignId: "camp-1", eventId: "x1" })
    );
    assert.equal(evt.ok, false);
    if (!evt.ok) assert.equal(evt.status, "rejected_unauthorized");

    assert.equal(node.sqlite.getSnapshot("tenant-a", "camp-1")?.metadata.name, "A");
    assert.equal(node.sqlite.getSnapshot("tenant-b", "camp-1"), null);
    node.destroy();
  });
});

test("restart recovery restores data and prepares gap requests without Browser/Claim", async () => {
  await withTempDir(async (dir) => {
    const first = await bootNode(dir, "stable-node");
    await first.node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-r",
      assignmentGeneration: 1,
    });
    await first.node.upsertCampaignSnapshot({
      tenantId: "tenant-a",
      campaignId: "camp-r",
      snapshotVersion: 1,
      sequence: 3,
      assignmentGeneration: 1,
      metadata: { title: "recover-me" },
    });
    await first.node.ingestJobEvent(
      baseEvent({
        eventId: "r1",
        campaignId: "camp-r",
        eventSequence: 1,
        eventType: "job_reserved",
      })
    );
    await first.node.ingestJobEvent(
      baseEvent({
        eventId: "r3",
        campaignId: "camp-r",
        eventSequence: 3,
        eventType: "job_started",
      })
    );
    await first.node.upsertScreenshotMetadata({
      id: "shot-r",
      tenantId: "tenant-a",
      campaignId: "camp-r",
      jobId: "job-1",
      attempt: 1,
      storageKey: "evidence/job-1-a1.png",
      sha256: "abc123",
      uploadStatus: "uploaded",
      serverAckAt: null,
    });
    first.node.destroy();

    const settings2 = new ClientStore(dir);
    await settings2.load();
    const node2 = new KeepAliveNodeService(dir, settings2);
    await node2.initialize();

    const diag = await node2.getDiagnostics();
    assert.equal(diag.enabled, true);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.assignedCampaignCount, 1);
    assert.equal(diag.campaignCount, 1);
    assert.ok(diag.lastRecoveryAttemptAt);

    const plan = node2.getLastRecoveryPlan();
    assert.ok(plan);
    assert.equal(plan.replaySocialActions, false);
    const camp = plan.campaigns.find((c) => c.campaignId === "camp-r");
    assert.ok(camp);
    assert.equal(camp.lastAppliedSequence, 1);
    assert.ok(camp.gaps.some((g) => g.fromSequence === 2 && g.toSequence === 2));
    assert.ok(camp.pendingScreenshotIds.includes("shot-r"));
    assert.ok(plan.requests.some((r) => r.type === "fetch_event_sequences"));

    const shot = node2.sqlite.getScreenshotMetadata("shot-r");
    assert.equal(shot?.storageKey, "evidence/job-1-a1.png");
    assert.equal(shot?.uploadStatus, "uploaded");
    assert.equal(shot?.serverAckAt, null);
    assert.equal(node2.sqlite.getJournalEvent("r1")?.eventType, "job_reserved");

    node2.destroy();
  });
});

test("screenshot metadata distinguishes upload vs job result; no binary in SQLite", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });
    await node.ingestJobEvent(
      baseEvent({ eventId: "done", eventSequence: 1, eventType: "job_completed" })
    );
    await node.upsertScreenshotMetadata({
      id: "s1",
      tenantId: "tenant-a",
      campaignId: "camp-1",
      jobId: "job-1",
      attempt: 1,
      storageKey: "shots/final.png",
      sha256: "deadbeef",
      uploadStatus: "pending",
    });

    const job = node.sqlite.getJobState("tenant-a", "camp-1", "job-1");
    assert.equal(job?.lastEventType, "job_completed");
    const shot = node.sqlite.getScreenshotMetadata("s1");
    assert.equal(shot?.uploadStatus, "pending");
    assert.equal(shot?.serverAckAt, null);
    assert.ok(!("binary" in (shot as object)));
    assert.ok(!JSON.stringify(shot).includes("iVBOR")); // no PNG payload
    node.destroy();
  });
});

test("received events never imply Job execution permission / claim stays off", async () => {
  await withTempDir(async (dir) => {
    const { node } = await bootNode(dir);
    await node.assignCampaign({
      tenantId: "tenant-a",
      campaignId: "camp-1",
      assignmentGeneration: 1,
    });
    const claimed = await node.ingestJobEvent(
      baseEvent({ eventId: "c1", eventSequence: 1, eventType: "job_claimed" })
    );
    assert.equal(claimed.ok, true);
    const diag = await node.getDiagnostics();
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(process.env.RPA_CAMPAIGN_CLAIM === "1", false);
    // No execute flag on diagnostics or event payload contract
    assert.equal("executePermission" in diag, false);
    node.destroy();
  });
});
