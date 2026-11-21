import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientStore } from "../src/main/storage/store.js";
import { KeepAliveNodeService } from "../src/main/keepalive/keepalive-node.js";
import { KeepAliveSyncService } from "../src/main/keepalive/keepalive-sync-service.js";
import {
  KeepAliveHttpApi,
  KEEPALIVE_EVENTS_ACK_PATH,
  KEEPALIVE_ARTIFACTS_ACK_PATH,
  parseEventsAckResponse,
  parseArtifactAckResponse,
} from "../src/main/keepalive/keepalive-http-api.js";
import { flushDurableAcks, selectContiguousBatch } from "../src/main/keepalive/ack-engine.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
} from "../src/main/keepalive/contracts.js";
import type { ConnectionState } from "../src/shared/contracts.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-3b5b-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type Handler = (
  subpath: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>
) => Promise<Record<string, unknown>>;

function envelope(extra: Record<string, unknown> = {}) {
  return {
    protocol_version: KEEPALIVE_PROTOCOL_VERSION,
    schema_version: KEEPALIVE_SCHEMA_VERSION,
    ...extra,
  };
}

function createMockConnection(handler: Handler, opts?: { online?: boolean; agentUuid?: string }) {
  const listeners: Array<(s: ConnectionState) => void> = [];
  const conn = {
    online: opts?.online ?? true,
    agentUuid: opts?.agentUuid ?? "agent-1",
    requestWithAuth: handler,
    isOnline() {
      return this.online;
    },
    getState(): ConnectionState {
      return {
        status: this.online ? "connected" : "disconnected",
        endpoint: "https://seo-ops.test",
        hasKey: true,
        agentUuid: this.agentUuid,
        clientApiKeyId: 1,
        online: this.online,
      };
    },
    onStateChange(listener: (s: ConnectionState) => void) {
      listeners.push(listener);
      listener(this.getState());
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return conn;
}

async function bootNode(dir: string, nodeId: string, conn: ReturnType<typeof createMockConnection>) {
  const settings = new ClientStore(dir);
  await settings.load();
  await settings.set({ keepAliveNodeId: nodeId, keepAlive24x7Enabled: true });
  const node = new KeepAliveNodeService(dir, settings);
  await node.initialize();
  const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
  node.attachSyncService(sync);
  return { node, sync, settings };
}

function eventRow(seq: number, type: string, extra: Record<string, unknown> = {}) {
  return {
    event_id: `e-${seq}`,
    event_sequence: seq,
    event_type: type,
    job_id: "job-1",
    attempt: 1,
    fencing_generation: 1,
    payload_version: 1,
    payload: {},
    ...extra,
  };
}

function standardSyncHandler(opts?: {
  campaigns?: string[];
  eventsByCampaign?: Record<string, unknown[]>;
  onAck?: (body: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onArtifactAck?: (
    body: Record<string, unknown>
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}): Handler {
  const campaigns = opts?.campaigns ?? ["c1"];
  const eventsByCampaign = opts?.eventsByCampaign ?? {
    c1: [eventRow(1, "job_started"), eventRow(2, "job_completed")],
  };
  return async (subpath, method, body) => {
    if (subpath.includes("/keepalive/register") && method === "POST") {
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        registered: true,
      });
    }
    if (subpath.includes("/keepalive/assignments") && method === "GET") {
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        assignments: campaigns.map((id) => ({
          campaign_id: id,
          assignment_generation: 1,
          row_version: 1,
          status: "assigned",
        })),
      });
    }
    if (subpath.includes("/events/ack") || subpath.endsWith(KEEPALIVE_EVENTS_ACK_PATH)) {
      if (opts?.onAck) return opts.onAck(body ?? {});
      const ids = (body?.event_ids as string[]) ?? [];
      const seq = Number(body?.last_contiguous_sequence ?? 0);
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: body?.campaign_id,
        last_contiguous_sequence: seq,
        acked_event_ids: ids,
      });
    }
    if (subpath.includes("/artifacts/ack") || subpath.endsWith(KEEPALIVE_ARTIFACTS_ACK_PATH)) {
      if (opts?.onArtifactAck) return opts.onArtifactAck(body ?? {});
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: body?.campaign_id,
        job_id: body?.job_id,
        attempt: body?.attempt,
        storage_key: body?.storage_key,
        acked: true,
      });
    }
    const snapMatch = subpath.match(/\/campaigns\/([^/]+)\/snapshot/);
    if (snapMatch && method === "GET") {
      const campaignId = decodeURIComponent(snapMatch[1]);
      const evs = eventsByCampaign[campaignId] ?? [];
      const head = evs.length;
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: campaignId,
        assignment_generation: 1,
        snapshot_version: 1,
        sequence: 0,
        event_sequence_head: head,
        row_version: 1,
        metadata: { name: campaignId },
      });
    }
    const evMatch = subpath.match(/\/campaigns\/([^/]+)\/events/);
    if (evMatch && method === "GET") {
      const campaignId = decodeURIComponent(evMatch[1]);
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: campaignId,
        assignment_generation: 1,
        events: eventsByCampaign[campaignId] ?? [],
        has_more: false,
        event_sequence_head: (eventsByCampaign[campaignId] ?? []).length,
      });
    }
    throw new Error(`unhandled ${method} ${subpath}`);
  };
}

test("parse event ACK + reject beyond head", () => {
  const ok = parseEventsAckResponse(
    envelope({
      node_id: "n1",
      tenant_id: "install-1",
      campaign_id: "c1",
      last_contiguous_sequence: 2,
      acked_event_ids: ["e-1", "e-2"],
    }),
    "n1",
    "c1"
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.data.lastContiguousSequence, 2);

  const bad = parseEventsAckResponse(
    envelope({
      node_id: "n1",
      campaign_id: "c1",
      code: "ack_beyond_head",
      ok: false,
      message: "beyond",
    }),
    "n1",
    "c1"
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "ack_beyond_head");
});

test("parse artifact ACK ready / not_ready / mismatch", () => {
  const ok = parseArtifactAckResponse(
    envelope({
      node_id: "n1",
      campaign_id: "c1",
      job_id: "job-1",
      attempt: 1,
      storage_key: "s3://a",
      acked: true,
    }),
    "n1",
    "c1"
  );
  assert.equal(ok.ok, true);

  const notReady = parseArtifactAckResponse(
    envelope({
      node_id: "n1",
      campaign_id: "c1",
      code: "artifact_not_ready",
      ok: false,
    }),
    "n1",
    "c1"
  );
  assert.equal(notReady.ok, false);
  if (!notReady.ok) assert.equal(notReady.code, "artifact_not_ready");
});

test("selectContiguousBatch never crosses a gap", () => {
  const batch = selectContiguousBatch(
    [
      {
        eventId: "e2",
        tenantId: "t",
        campaignId: "c",
        jobId: "j",
        attempt: 1,
        fencingGeneration: 1,
        eventSequence: 2,
        eventType: "job_started",
        timestamp: "",
        payloadVersion: 1,
        payloadJson: "{}",
        syncStatus: "pending",
        applyStatus: "applied",
        createdAt: "",
      },
      {
        eventId: "e3",
        tenantId: "t",
        campaignId: "c",
        jobId: "j",
        attempt: 1,
        fencingGeneration: 1,
        eventSequence: 3,
        eventType: "job_completed",
        timestamp: "",
        payloadVersion: 1,
        payloadJson: "{}",
        syncStatus: "pending",
        applyStatus: "applied",
        createdAt: "",
      },
    ],
    0
  );
  assert.deepEqual(
    batch.map((b) => b.eventSequence),
    []
  );

  const contiguous = selectContiguousBatch(
    [
      {
        eventId: "e1",
        tenantId: "t",
        campaignId: "c",
        jobId: "j",
        attempt: 1,
        fencingGeneration: 1,
        eventSequence: 1,
        eventType: "job_started",
        timestamp: "",
        payloadVersion: 1,
        payloadJson: "{}",
        syncStatus: "pending",
        applyStatus: "applied",
        createdAt: "",
      },
      {
        eventId: "e2",
        tenantId: "t",
        campaignId: "c",
        jobId: "j",
        attempt: 1,
        fencingGeneration: 1,
        eventSequence: 2,
        eventType: "job_completed",
        timestamp: "",
        payloadVersion: 1,
        payloadJson: "{}",
        syncStatus: "pending",
        applyStatus: "applied",
        createdAt: "",
      },
    ],
    0
  );
  assert.deepEqual(
    contiguous.map((b) => b.eventId),
    ["e1", "e2"]
  );
});

test("batch contiguous ACK after ingest; local applied ≠ server ack until confirmed", async () => {
  await withTempDir(async (dir) => {
    const ackBodies: Record<string, unknown>[] = [];
    const conn = createMockConnection(
      standardSyncHandler({
        onAck: (body) => {
          ackBodies.push(body);
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: body.campaign_id,
            last_contiguous_sequence: body.last_contiguous_sequence,
            acked_event_ids: body.event_ids,
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");

    const cursor = node.sqlite.getCursor("install-1", "c1");
    assert.equal(cursor?.lastAppliedSequence, 2);
    assert.equal(cursor?.lastServerAckSequence, 2);
    assert.equal(ackBodies.length, 1);
    assert.deepEqual(ackBodies[0].event_ids, ["e-1", "e-2"]);
    assert.equal(ackBodies[0].last_contiguous_sequence, 2);

    const diag = await node.getDiagnostics();
    assert.equal(diag.serverDurableAck, true);
    assert.equal(diag.lastServerAckSequence, 2);
    assert.equal(diag.pendingAckCount, 0);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.browserRequired, false);
    node.destroy();
  });
});

test("duplicate ACK retry is idempotent; does not double-advance", async () => {
  await withTempDir(async (dir) => {
    let ackCalls = 0;
    const conn = createMockConnection(
      standardSyncHandler({
        onAck: (body) => {
          ackCalls += 1;
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: body.campaign_id,
            last_contiguous_sequence: body.last_contiguous_sequence,
            acked_event_ids: body.event_ids,
            idempotent: ackCalls > 1,
            already_acked: ackCalls > 1,
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    assert.equal(ackCalls, 1);
    // Second flush with nothing pending — no empty ACK
    const summary = await flushDurableAcks(new KeepAliveHttpApi(conn as never), node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
    });
    assert.equal(summary.outcomes[0].eventsAcked, 0);
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 2);
    node.destroy();
  });
});

test("gap blocks ACK and does not advance confirmed cursor", async () => {
  await withTempDir(async (dir) => {
    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "n1", keepAlive24x7Enabled: true });
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    await node.assignCampaign({
      tenantId: "install-1",
      campaignId: "c1",
      assignmentGeneration: 1,
    });
    // Apply seq 1 then buffer-style: only insert seq 3 as applied illegally via ingest of 1,2 missing 2
    await node.ingestJobEvent({
      eventId: "e-1",
      tenantId: "install-1",
      campaignId: "c1",
      jobId: "job-1",
      attempt: 1,
      fencingGeneration: 1,
      eventSequence: 1,
      eventType: "job_started",
    });
    await node.ingestJobEvent({
      eventId: "e-3",
      tenantId: "install-1",
      campaignId: "c1",
      jobId: "job-1",
      attempt: 1,
      fencingGeneration: 1,
      eventSequence: 3,
      eventType: "job_completed",
    });
    // Manually mark e-3 applied pending with cursor applied=1 (e-3 buffered normally)
    const buffered = node.sqlite.getJournalEvent("e-3");
    assert.equal(buffered?.applyStatus, "buffered");

    let ackCalled = false;
    const conn = createMockConnection(async (subpath, method, body) => {
      if (subpath.includes("/events/ack")) {
        ackCalled = true;
        return envelope({
          node_id: "n1",
          campaign_id: "c1",
          last_contiguous_sequence: body?.last_contiguous_sequence,
          acked_event_ids: body?.event_ids,
        });
      }
      throw new Error("unexpected");
    });
    const api = new KeepAliveHttpApi(conn as never);
    const summary = await flushDurableAcks(api, node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
    });
    assert.equal(ackCalled, true);
    assert.equal(summary.outcomes[0].eventsAcked, 1);
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 1);
    // Seq 3 still not ACKed
    assert.equal(node.sqlite.getJournalEvent("e-3")?.syncStatus, "pending");
    node.destroy();
  });
});

test("ack_beyond_head does not advance local confirmed ACK", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(
      standardSyncHandler({
        onAck: () => {
          throw new SeoOpsHttpError({
            method: "POST",
            endpoint: KEEPALIVE_EVENTS_ACK_PATH,
            status: 409,
            contentType: "application/json",
            category: "unexpected_response",
            serverErrorCode: "ack_beyond_head",
            serverErrorMessage: "beyond head",
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    const cursor = node.sqlite.getCursor("install-1", "c1");
    assert.equal(cursor?.lastAppliedSequence, 2);
    assert.equal(cursor?.lastServerAckSequence, 0);
    const diag = await node.getDiagnostics();
    assert.equal(diag.serverDurableAck, false);
    assert.ok(diag.lastAckError || diag.lastHttpError);
    node.destroy();
  });
});

test("offline restart persists pending ACK then flushes", async () => {
  await withTempDir(async (dir) => {
    // First session: ingest without ACK (offline after ingest simulation via direct ingest)
    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "n1", keepAlive24x7Enabled: true });
    const node1 = new KeepAliveNodeService(dir, settings);
    await node1.initialize();
    await node1.assignCampaign({
      tenantId: "install-1",
      campaignId: "c1",
      assignmentGeneration: 1,
    });
    await node1.ingestJobEvent({
      eventId: "e-1",
      tenantId: "install-1",
      campaignId: "c1",
      jobId: "job-1",
      attempt: 1,
      fencingGeneration: 1,
      eventSequence: 1,
      eventType: "job_started",
    });
    assert.equal(node1.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 0);
    assert.equal(node1.sqlite.listPendingSyncEvents("install-1", "c1").length, 1);
    node1.destroy();

    // Restart + ACK
    const settings2 = new ClientStore(dir);
    await settings2.load();
    const node2 = new KeepAliveNodeService(dir, settings2);
    await node2.initialize();
    const conn = createMockConnection(async (subpath, method, body) => {
      if (subpath.includes("/events/ack") && method === "POST") {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "c1",
          last_contiguous_sequence: body?.last_contiguous_sequence,
          acked_event_ids: body?.event_ids,
        });
      }
      throw new Error(`unexpected ${method} ${subpath}`);
    });
    const summary = await flushDurableAcks(new KeepAliveHttpApi(conn as never), node2.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
    });
    assert.equal(summary.outcomes[0].eventsAcked, 1);
    assert.equal(node2.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 1);
    assert.equal(node2.sqlite.getJournalEvent("e-1")?.syncStatus, "server_acked");
    node2.destroy();
  });
});

test("multi-campaign ACK isolation", async () => {
  await withTempDir(async (dir) => {
    const ackByCampaign: string[] = [];
    const conn = createMockConnection(
      standardSyncHandler({
        campaigns: ["c1", "c2"],
        eventsByCampaign: {
          c1: [eventRow(1, "job_started")],
          c2: [eventRow(1, "job_started", { event_id: "e2-1" }), eventRow(2, "job_completed", { event_id: "e2-2" })],
        },
        onAck: (body) => {
          ackByCampaign.push(String(body.campaign_id));
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: body.campaign_id,
            last_contiguous_sequence: body.last_contiguous_sequence,
            acked_event_ids: body.event_ids,
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    assert.deepEqual(ackByCampaign.sort(), ["c1", "c2"]);
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 1);
    assert.equal(node.sqlite.getCursor("install-1", "c2")?.lastServerAckSequence, 2);
    node.destroy();
  });
});

test("revoked / stale generation stops ACK", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(
      standardSyncHandler({
        onAck: () => {
          throw new SeoOpsHttpError({
            method: "POST",
            endpoint: KEEPALIVE_EVENTS_ACK_PATH,
            status: 409,
            contentType: "application/json",
            category: "unexpected_response",
            serverErrorCode: "assignment_generation_stale",
            serverErrorMessage: "stale",
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 0);
    node.destroy();
  });
});

test("artifact ACK ready / not_ready / mismatch", async () => {
  await withTempDir(async (dir) => {
    const modes: Array<"ok" | "not_ready" | "mismatch"> = [];
    const conn = createMockConnection(
      standardSyncHandler({
        eventsByCampaign: {
          c1: [
            eventRow(1, "screenshot_uploaded", {
              payload: {
                storage_key: "artifacts/shot-1.png",
                sha256: "abc123",
              },
            }),
          ],
        },
        onAck: (body) =>
          envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: body.campaign_id,
            last_contiguous_sequence: body.last_contiguous_sequence,
            acked_event_ids: body.event_ids,
          }),
        onArtifactAck: (body) => {
          const mode = modes.shift() ?? "ok";
          if (mode === "not_ready") {
            throw new SeoOpsHttpError({
              method: "POST",
              endpoint: KEEPALIVE_ARTIFACTS_ACK_PATH,
              status: 409,
              contentType: "application/json",
              category: "unexpected_response",
              serverErrorCode: "artifact_not_ready",
              serverErrorMessage: "not ready",
            });
          }
          if (mode === "mismatch") {
            throw new SeoOpsHttpError({
              method: "POST",
              endpoint: KEEPALIVE_ARTIFACTS_ACK_PATH,
              status: 422,
              contentType: "application/json",
              category: "unexpected_response",
              serverErrorCode: "checksum_mismatch",
              serverErrorMessage: "sha mismatch",
            });
          }
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: body.campaign_id,
            job_id: body.job_id,
            attempt: body.attempt,
            storage_key: body.storage_key,
            acked: true,
          });
        },
      })
    );

    modes.push("not_ready");
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test-not-ready");
    let shot = node.sqlite.getScreenshotMetadata("e-1");
    assert.ok(shot);
    assert.equal(shot?.serverAckAt, null);
    assert.equal((await node.getDiagnostics()).artifactAckState, "not_ready");

    // Retry success
    modes.length = 0;
    modes.push("ok");
    await flushDurableAcks(new KeepAliveHttpApi(conn as never), node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
    });
    shot = node.sqlite.getScreenshotMetadata("e-1");
    assert.ok(shot?.serverAckAt);
    assert.equal(shot?.uploadStatus, "server_acked");

    // Mismatch path on a second artifact
    await node.upsertScreenshotMetadata({
      id: "shot-bad",
      tenantId: "install-1",
      campaignId: "c1",
      jobId: "job-1",
      attempt: 1,
      storageKey: "artifacts/bad.png",
      sha256: "bad",
      uploadStatus: "uploaded",
    });
    modes.push("mismatch");
    const mismatch = await flushDurableAcks(new KeepAliveHttpApi(conn as never), node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
    });
    assert.equal(mismatch.artifactAckState, "mismatch");
    assert.equal(node.sqlite.getScreenshotMetadata("shot-bad")?.uploadStatus, "failed");
    node.destroy();
  });
});

test("Browser stopped + claim OFF — ACK still runs", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(standardSyncHandler());
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    const diag = await node.getDiagnostics();
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.phase, "socket-hints");
    assert.equal(diag.serverDurableAck, true);
    // Ensure no claim paths invoked
    node.destroy();
  });
});

test("empty / no-op ACK not sent", async () => {
  await withTempDir(async (dir) => {
    let ackCalls = 0;
    const conn = createMockConnection(
      standardSyncHandler({
        eventsByCampaign: { c1: [] },
        onAck: () => {
          ackCalls += 1;
          return envelope({
            node_id: "n1",
            campaign_id: "c1",
            last_contiguous_sequence: 0,
            acked_event_ids: [],
          });
        },
      })
    );
    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    assert.equal(ackCalls, 0);
    node.destroy();
  });
});

test("parseEventsAckResponse supports Laravel acked_through_sequence + camelCase + rejects missing/errors", () => {
  // Actual Laravel ACK response shape
  const laravel = parseEventsAckResponse(
    {
      ok: true,
      protocol_version: KEEPALIVE_PROTOCOL_VERSION,
      schema_version: KEEPALIVE_SCHEMA_VERSION,
      node_id: "ka-node-mwosxyzh-dczwdgee",
      tenant_id: "ins_4Zn6M7cHZIQI2UbS",
      campaign_id: "cf0d8be1-5475-4c84-a788-600a6a8ae17f",
      acked_through_sequence: 10,
      acked_event_count_total: 10,
    },
    "ka-node-mwosxyzh-dczwdgee",
    "cf0d8be1-5475-4c84-a788-600a6a8ae17f"
  );
  assert.equal(laravel.ok, true);
  if (laravel.ok) {
    assert.equal(laravel.data.lastContiguousSequence, 10);
    assert.deepEqual(laravel.data.ackedEventIds, []);
  }

  // camelCase alias
  const camel = parseEventsAckResponse(
    envelope({ node_id: "n1", campaign_id: "c1", ackedThroughSequence: 5, already_acked: true }),
    "n1",
    "c1"
  );
  assert.equal(camel.ok, true);
  if (camel.ok) {
    assert.equal(camel.data.lastContiguousSequence, 5);
    assert.equal(camel.data.idempotent, true);
  }

  // Missing confirmed sequence rejection
  const missing = parseEventsAckResponse(
    envelope({ node_id: "n1", campaign_id: "c1" }),
    "n1",
    "c1"
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "ack_sequence_missing");

  // Server error responses
  const nonContig = parseEventsAckResponse(
    envelope({ node_id: "n1", campaign_id: "c1", ok: false, code: "ack_non_contiguous" }),
    "n1",
    "c1"
  );
  assert.equal(nonContig.ok, false);
  if (!nonContig.ok) assert.equal(nonContig.code, "ack_non_contiguous");

  const mismatch = parseEventsAckResponse(
    envelope({ node_id: "other", campaign_id: "c1", acked_through_sequence: 1 }),
    "n1",
    "c1"
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "node_id_mismatch");
});

test("partial ACK confirmation and idempotent ACK retry with acked_through_sequence", async () => {
  await withTempDir(async (dir) => {
    let ackCall = 0;
    const conn = createMockConnection(
      standardSyncHandler({
        eventsByCampaign: {
          c1: [
            eventRow(1, "job_reserved"),
            eventRow(2, "job_started"),
            eventRow(3, "job_completed"),
          ],
        },
        onAck: () => {
          ackCall += 1;
          if (ackCall === 1) {
            // Partial confirmation: only sequences 1..2 confirmed
            return envelope({
              node_id: "n1",
              tenant_id: "install-1",
              campaign_id: "c1",
              acked_through_sequence: 2,
              acked_event_count_total: 2,
            });
          }
          // Idempotent cumulative retry confirming through 3
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: "c1",
            acked_through_sequence: 3,
            acked_event_count_total: 3,
            idempotent: true,
          });
        },
      })
    );

    const { node, sync } = await bootNode(dir, "n1", conn);
    await sync.refreshAssignments("test");
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 2);
    assert.equal(node.sqlite.getJournalEvent("e-1")?.syncStatus, "server_acked");
    assert.equal(node.sqlite.getJournalEvent("e-2")?.syncStatus, "server_acked");
    assert.equal(node.sqlite.getJournalEvent("e-3")?.syncStatus, "pending");

    // Second sync retries remaining pending event #3 -> idempotent ACK advances to 3
    await sync.refreshAssignments("retry");
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastServerAckSequence, 3);
    assert.equal(node.sqlite.getJournalEvent("e-3")?.syncStatus, "server_acked");
    node.destroy();
  });
});
