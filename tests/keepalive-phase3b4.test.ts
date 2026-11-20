import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientStore } from "../src/main/storage/store.js";
import { KeepAliveNodeService } from "../src/main/keepalive/keepalive-node.js";
import { KeepAliveSyncService } from "../src/main/keepalive/keepalive-sync-service.js";
import {
  KeepAliveHttpApi,
  parseEventsResponse,
  parseSnapshotResponse,
  KEEPALIVE_CAMPAIGNS_BASE,
} from "../src/main/keepalive/keepalive-http-api.js";
import { syncAssignedCampaignData } from "../src/main/keepalive/campaign-data-sync.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
} from "../src/main/keepalive/contracts.js";
import type { ConnectionState } from "../src/shared/contracts.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-3b4-"));
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
  await settings.set({ keepAliveNodeId: nodeId });
  const node = new KeepAliveNodeService(dir, settings);
  await node.initialize();
  const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
  node.attachSyncService(sync);
  return { node, sync, settings };
}

function snapBody(campaignId: string, overrides: Record<string, unknown> = {}) {
  return envelope({
    node_id: "n1",
    tenant_id: "install-1",
    campaign_id: campaignId,
    assignment_generation: 1,
    snapshot_version: 1,
    sequence: 0,
    event_sequence_head: 2,
    row_version: 3,
    metadata: { name: "Camp", platform: "wordpress" },
    ...overrides,
  });
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

test("parse snapshot accepts row_version and version alias; rejects cross-tenant", () => {
  const ok = parseSnapshotResponse(
    snapBody("c1", { version: 9, row_version: undefined }),
    "n1",
    "c1"
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.rowVersion, 9);
    assert.equal(ok.data.tenantId, "install-1");
    assert.equal(ok.data.eventSequenceHead, 2);
  }

  const bad = parseSnapshotResponse(snapBody("other"), "n1", "c1");
  assert.equal(bad.ok, false);
});

test("parse events pagination + tenant mismatch", () => {
  const page = parseEventsResponse(
    envelope({
      node_id: "n1",
      tenant_id: "install-1",
      campaign_id: "c1",
      assignment_generation: 1,
      events: [eventRow(1, "job_started")],
      next_cursor: "page-2",
      has_more: true,
      event_sequence_head: 5,
    }),
    "n1",
    "c1"
  );
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.data.nextCursor, "page-2");
    assert.equal(page.data.hasMore, true);
    assert.equal(page.data.eventSequenceHead, 5);
  }

  const cross = parseEventsResponse(
    envelope({
      node_id: "n1",
      tenant_id: "install-1",
      campaign_id: "c1",
      assignment_generation: 1,
      events: [eventRow(1, "job_started", { tenant_id: "other" })],
    }),
    "n1",
    "c1"
  );
  assert.equal(cross.ok, false);
});

test("snapshot fetch requires explicit assignment; success persists metadata", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(async (subpath) => {
      if (subpath.includes("/snapshot")) return snapBody("camp-a");
      if (subpath.includes("/events")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "camp-a",
          assignment_generation: 1,
          events: [],
          has_more: false,
          event_sequence_head: 0,
        });
      }
      throw new Error(subpath);
    });
    const { node } = await bootNode(dir, "n1", conn);
    const api = new KeepAliveHttpApi(conn as never);

    const unauthorized = await syncAssignedCampaignData(api, node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
      campaignId: "camp-a",
      assignmentGeneration: 1,
    });
    assert.match(unauthorized.error ?? "", /assign/i);

    await node.assignCampaign({
      tenantId: "install-1",
      campaignId: "camp-a",
      assignmentGeneration: 1,
      rowVersion: 1,
    });
    const ok = await syncAssignedCampaignData(api, node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
      campaignId: "camp-a",
      assignmentGeneration: 1,
    });
    assert.equal(ok.snapshotOk, true);
    assert.equal(node.sqlite.getSnapshot("install-1", "camp-a")?.metadata.name, "Camp");
    node.destroy();
  });
});

test("event pagination, duplicates, out-of-order buffer, no progress events", async () => {
  await withTempDir(async (dir) => {
    let page = 0;
    const conn = createMockConnection(async (subpath) => {
      if (subpath.includes("/snapshot")) {
        return snapBody("camp-b", { event_sequence_head: 3 });
      }
      if (subpath.includes("/events")) {
        page += 1;
        if (page === 1) {
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            campaign_id: "camp-b",
            assignment_generation: 1,
            events: [
              eventRow(3, "job_completed"),
              eventRow(1, "job_reserved"),
              eventRow(99, "job_progress"), // transient — skipped
            ],
            next_cursor: "p2",
            has_more: true,
            event_sequence_head: 3,
          });
        }
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "camp-b",
          assignment_generation: 1,
          events: [
            eventRow(2, "job_started"),
            eventRow(1, "job_reserved"), // duplicate id path via same event_id e-1
          ],
          has_more: false,
          event_sequence_head: 3,
        });
      }
      throw new Error(subpath);
    });
    const { node } = await bootNode(dir, "n1", conn);
    await node.assignCampaign({
      tenantId: "install-1",
      campaignId: "camp-b",
      assignmentGeneration: 1,
    });
    const api = new KeepAliveHttpApi(conn as never);
    const out = await syncAssignedCampaignData(api, node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
      campaignId: "camp-b",
      assignmentGeneration: 1,
    });
    assert.equal(out.snapshotOk, true);
    assert.ok(out.pages >= 2);
    assert.ok(out.eventsSkippedTransient >= 1);
    assert.equal(node.sqlite.getCursor("install-1", "camp-b")?.lastAppliedSequence, 3);
    assert.equal(node.sqlite.getJournalEvent("e-3")?.applyStatus, "applied");
    // head hint may raise last_seen but never proves persistence alone
    assert.ok((node.sqlite.getCursor("install-1", "camp-b")?.lastSeenSequence ?? 0) >= 3);
    node.destroy();
  });
});

test("multiple campaigns + fencing conflict + generation stale 409", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(async (subpath, method, body) => {
      if (method === "POST" && subpath.endsWith("/register")) {
        return envelope({ node_id: "n1", tenant_id: "install-1", registered: true });
      }
      if (subpath.includes("/events/ack")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: body?.campaign_id,
          last_contiguous_sequence: body?.last_contiguous_sequence ?? 0,
          acked_event_ids: body?.event_ids ?? [],
        });
      }
      if (subpath.includes("/artifacts/ack")) {
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
      if (subpath.includes("/assignments")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          assignments: [
            { campaign_id: "c1", assignment_generation: 1, row_version: 1 },
            { campaign_id: "c2", assignment_generation: 1, row_version: 1 },
          ],
        });
      }
      if (subpath.includes("/c1/snapshot")) return snapBody("c1", { event_sequence_head: 1 });
      if (subpath.includes("/c2/snapshot")) {
        throw new SeoOpsHttpError({
          method: "GET",
          endpoint: `${KEEPALIVE_CAMPAIGNS_BASE}/c2/snapshot`,
          status: 409,
          contentType: "application/json",
          category: "unexpected_response",
          serverErrorCode: "assignment_generation_stale",
          serverErrorMessage: "generation bumped",
        });
      }
      if (subpath.includes("/c1/events")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "c1",
          assignment_generation: 1,
          events: [
            eventRow(1, "job_started", { fencing_generation: 2, attempt: 2 }),
            eventRow(2, "job_failed", { fencing_generation: 1, attempt: 9 }), // stale fence
          ],
          has_more: false,
          event_sequence_head: 2,
        });
      }
      if (subpath.includes("/c2/events")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "c2",
          assignment_generation: 1,
          events: [],
          has_more: false,
        });
      }
      throw new Error(subpath);
    });

    const { node, sync } = await bootNode(dir, "n1", conn);
    await node.setEnabled(true);
    const diag = await node.getDiagnostics();
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.browserRequired, false);
    // c1 may ACK seq 1; c2 snapshot stale — durable ACK capability may be true for c1 only
    assert.equal(typeof diag.serverDurableAck, "boolean");
    assert.ok(diag.assignedCampaignCount >= 1);
    assert.equal(node.sqlite.getJobState("install-1", "c1", "job-1")?.fencingGeneration, 2);
    assert.equal(node.sqlite.getJournalEvent("e-2")?.applyStatus, "rejected_stale");
    assert.ok(sync.getState().snapshotSyncStatus === "partial" || sync.getState().snapshotSyncStatus === "error" || sync.getState().snapshotSyncStatus === "synced");
    node.destroy();
  });
});

test("unauthorized before assignment; network failure; browser stopped; claim OFF", async () => {
  await withTempDir(async (dir) => {
    let failEvents = false;
    const conn = createMockConnection(async (subpath, method, body) => {
      if (method === "POST" && subpath.endsWith("/register")) {
        return envelope({ node_id: "n1", tenant_id: "install-1", registered: true });
      }
      if (subpath.includes("/events/ack")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: body?.campaign_id,
          last_contiguous_sequence: body?.last_contiguous_sequence ?? 0,
          acked_event_ids: body?.event_ids ?? [],
        });
      }
      if (subpath.includes("/artifacts/ack")) {
        return envelope({
          node_id: "n1",
          campaign_id: body?.campaign_id,
          acked: true,
          job_id: body?.job_id,
          attempt: body?.attempt,
          storage_key: body?.storage_key,
        });
      }
      if (subpath.includes("/assignments")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          assignments: [{ campaign_id: "cx", assignment_generation: 1, row_version: 1 }],
        });
      }
      if (subpath.includes("/snapshot")) return snapBody("cx", { event_sequence_head: 1 });
      if (subpath.includes("/events")) {
        if (failEvents) throw new Error("fetch failed");
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "cx",
          assignment_generation: 1,
          events: [eventRow(1, "job_started")],
          has_more: false,
          event_sequence_head: 1,
        });
      }
      throw new Error(subpath);
    });

    // No ProfileManager / EmbeddedBrowser constructed
    const { node, sync } = await bootNode(dir, "n1", conn);
    await node.setEnabled(true);
    assert.equal(process.env.RPA_CAMPAIGN_CLAIM === "1", false);
    assert.equal((await node.getDiagnostics()).claimRuntimeEnabled, false);
    assert.equal(node.sqlite.getCursor("install-1", "cx")?.lastAppliedSequence, 1);

    failEvents = true;
    await sync.refreshAssignments("manual");
    assert.ok(sync.getState().lastHttpError);

    // 401 on snapshot
    const conn401 = createMockConnection(async () => {
      throw new SeoOpsHttpError({
        method: "GET",
        endpoint: "/snapshot",
        status: 401,
        contentType: "application/json",
        category: "authentication",
        serverErrorCode: "unauthorized",
        serverErrorMessage: "nope",
      });
    });
    const api = new KeepAliveHttpApi(conn401 as never);
    await node.assignCampaign({
      tenantId: "install-1",
      campaignId: "cz",
      assignmentGeneration: 1,
    });
    const denied = await syncAssignedCampaignData(api, node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
      campaignId: "cz",
      assignmentGeneration: 1,
    });
    assert.equal(denied.authFatal, true);
    node.destroy();
  });
});

test("restart recovery retains journal; head ahead does not advance applied", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection(async (subpath) => {
      if (subpath.includes("/snapshot")) {
        return snapBody("cr", { event_sequence_head: 10, sequence: 1 });
      }
      if (subpath.includes("/events")) {
        return envelope({
          node_id: "n1",
          tenant_id: "install-1",
          campaign_id: "cr",
          assignment_generation: 1,
          events: [eventRow(1, "job_reserved")],
          has_more: false,
          event_sequence_head: 10,
        });
      }
      throw new Error(subpath);
    });
    const first = await bootNode(dir, "n1", conn);
    await first.node.assignCampaign({
      tenantId: "install-1",
      campaignId: "cr",
      assignmentGeneration: 1,
    });
    const api = new KeepAliveHttpApi(conn as never);
    const out = await syncAssignedCampaignData(api, first.node.sqlite, {
      nodeId: "n1",
      tenantId: "install-1",
      campaignId: "cr",
      assignmentGeneration: 1,
    });
    assert.equal(out.lastAppliedSequence, 1);
    assert.ok(out.pendingRecovery); // head 10 ahead of applied 1
    assert.notEqual(out.lastAppliedSequence, 10);
    first.node.destroy();

    const settings2 = new ClientStore(dir);
    await settings2.load();
    const node2 = new KeepAliveNodeService(dir, settings2);
    await node2.initialize();
    assert.equal(node2.sqlite.getJournalEvent("e-1")?.eventType, "job_reserved");
    assert.equal(node2.sqlite.getCursor("install-1", "cr")?.lastAppliedSequence, 1);
    node2.destroy();
  });
});

test("wiring contract: snapshot/events paths + claim remains opt-in", async () => {
  const http = await readFile(
    new URL("../src/main/keepalive/keepalive-http-api.ts", import.meta.url),
    "utf8"
  );
  const sync = await readFile(
    new URL("../src/main/keepalive/keepalive-sync-service.ts", import.meta.url),
    "utf8"
  );
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const panel = await readFile(
    new URL("../src/renderer/components/keepalive-diagnostics-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(http, /\/snapshot/);
  assert.match(http, /\/events/);
  assert.match(http, /assignment_generation_stale/);
  assert.match(sync, /syncAllAssignedCampaignData/);
  assert.match(main, /RPA_CAMPAIGN_CLAIM/);
  assert.match(panel, /Pending recovery/);
  assert.match(panel, /Local applied sequence|Server ACK sequence/);
  assert.doesNotMatch(panel, /claimCampaign/i);
});
