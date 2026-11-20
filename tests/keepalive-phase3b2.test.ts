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
  parseAssignmentsResponse,
  parseRegisterResponse,
  type KeepAliveHttpResult,
  type KeepAliveRegisterResponse,
  type KeepAliveAssignmentsResponse,
} from "../src/main/keepalive/keepalive-http-api.js";
import { applyServerAssignments } from "../src/main/keepalive/assignment-apply.js";
import { KEEPALIVE_PROTOCOL_VERSION, KEEPALIVE_SCHEMA_VERSION } from "../src/main/keepalive/contracts.js";
import type { ConnectionState } from "../src/shared/contracts.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-3b2-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type MockConn = {
  online: boolean;
  agentUuid: string | null;
  listeners: Array<(s: ConnectionState) => void>;
  requestWithAuth: (
    subpath: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  isOnline: () => boolean;
  getState: () => ConnectionState;
  onStateChange: (listener: (state: ConnectionState) => void) => () => void;
  setOnline: (online: boolean) => void;
};

function createMockConnection(opts?: {
  online?: boolean;
  agentUuid?: string | null;
  handler?: MockConn["requestWithAuth"];
}): MockConn {
  const listeners: Array<(s: ConnectionState) => void> = [];
  const conn: MockConn = {
    online: opts?.online ?? true,
    agentUuid: opts?.agentUuid === undefined ? "agent-1" : opts.agentUuid,
    listeners,
    requestWithAuth:
      opts?.handler ??
      (async () => {
        throw new Error("unhandled");
      }),
    isOnline() {
      return this.online;
    },
    getState() {
      return {
        status: this.online ? "connected" : "disconnected",
        endpoint: "https://seo-ops.test",
        hasKey: true,
        agentUuid: this.agentUuid ?? undefined,
        clientApiKeyId: 7,
        online: this.online,
      };
    },
    onStateChange(listener) {
      listeners.push(listener);
      listener(this.getState());
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    setOnline(online: boolean) {
      this.online = online;
      for (const l of listeners) l(this.getState());
    },
  };
  return conn;
}

function envelope(extra: Record<string, unknown> = {}) {
  return {
    protocol_version: KEEPALIVE_PROTOCOL_VERSION,
    schema_version: KEEPALIVE_SCHEMA_VERSION,
    ...extra,
  };
}

async function boot(dir: string, conn: MockConn) {
  const settings = new ClientStore(dir);
  await settings.load();
  const node = new KeepAliveNodeService(dir, settings);
  await node.initialize();
  const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
  node.attachSyncService(sync);
  return { settings, node, sync };
}

test("parse register success and duplicate/idempotent", () => {
  const ok = parseRegisterResponse(
    envelope({
      node_id: "n1",
      tenant_id: "t1",
      registered: true,
      idempotent: true,
    }),
    "n1"
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.data.tenantId, "t1");

  const dup = parseRegisterResponse(
    envelope({
      node_id: "n1",
      already_registered: true,
      ok: true,
    }),
    "n1"
  );
  assert.equal(dup.ok, true);
});

test("parse rejects protocol mismatch and node mismatch", () => {
  const proto = parseRegisterResponse(
    { protocol_version: "keepalive.v0", schema_version: 2, node_id: "n1", registered: true },
    "n1"
  );
  assert.equal(proto.ok, false);
  if (!proto.ok) {
    assert.equal(proto.code, "protocol_mismatch");
    assert.equal(proto.fatal, true);
  }

  const node = parseRegisterResponse(
    envelope({ node_id: "other", registered: true }),
    "n1"
  );
  assert.equal(node.ok, false);
  if (!node.ok) assert.equal(node.code, "node_id_mismatch");
});

test("parse assignments empty / multiple + tenant isolation", () => {
  const empty = parseAssignmentsResponse(
    envelope({ node_id: "n1", tenant_id: "t1", assignments: [] }),
    "n1"
  );
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.data.assignments.length, 0);

  const multi = parseAssignmentsResponse(
    envelope({
      node_id: "n1",
      tenant_id: "t1",
      assignments: [
        { campaign_id: "c1", assignment_generation: 1, row_version: 1 },
        { campaign_id: "c2", assignment_generation: 2, row_version: 5, status: "assigned" },
      ],
    }),
    "n1"
  );
  assert.equal(multi.ok, true);
  if (multi.ok) assert.equal(multi.data.assignments.length, 2);

  const cross = parseAssignmentsResponse(
    envelope({
      node_id: "n1",
      tenant_id: "t1",
      assignments: [{ campaign_id: "c1", assignment_generation: 1, tenant_id: "t2" }],
    }),
    "n1"
  );
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.code, "tenant_mismatch");
});

test("registration success then assignments applied without Browser", async () => {
  await withTempDir(async (dir) => {
    let registerCalls = 0;
    const conn = createMockConnection({
      handler: async (subpath, method, body) => {
        if (method === "POST" && subpath.endsWith("/keepalive/register")) {
          registerCalls += 1;
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            registered: true,
          });
        }
        if (method === "GET" && subpath.includes("/keepalive/assignments")) {
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            assignments: [
              { campaign_id: "camp-1", assignment_generation: 3, row_version: 9 },
              { campaign_id: "camp-2", assignment_generation: 1, row_version: 1 },
            ],
          });
        }
        if (subpath.includes("/events/ack")) {
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            campaign_id: body?.campaign_id,
            last_contiguous_sequence: body?.last_contiguous_sequence ?? 0,
            acked_event_ids: body?.event_ids ?? [],
          });
        }
        if (subpath.includes("/artifacts/ack")) {
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            campaign_id: body?.campaign_id,
            job_id: body?.job_id,
            attempt: body?.attempt,
            storage_key: body?.storage_key,
            acked: true,
          });
        }
        if (subpath.includes("/snapshot")) {
          const camp = subpath.includes("camp-2") ? "camp-2" : "camp-1";
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            campaign_id: camp,
            assignment_generation: camp === "camp-1" ? 3 : 1,
            snapshot_version: 1,
            sequence: 0,
            event_sequence_head: 0,
            row_version: 1,
            metadata: { name: camp },
          });
        }
        if (subpath.includes("/events")) {
          const camp = subpath.includes("camp-2") ? "camp-2" : "camp-1";
          return envelope({
            node_id: "fixed-node",
            tenant_id: "tenant-a",
            campaign_id: camp,
            assignment_generation: camp === "camp-1" ? 3 : 1,
            events: [],
            has_more: false,
            event_sequence_head: 0,
          });
        }
        throw new Error(`unexpected ${method} ${subpath}`);
      },
    });

    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "fixed-node" });
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
    node.attachSyncService(sync);

    await node.setEnabled(true);
    // Deduped second enable/sync should not double-register for same connection key
    await sync.refreshAssignments("manual");
    assert.equal(registerCalls, 1);

    const diag = await node.getDiagnostics();
    assert.equal(diag.registrationStatus, "registered");
    assert.equal(diag.serverRegistrationConfirmed, true);
    assert.equal(diag.campaignAssignmentConfirmed, true);
    assert.equal(diag.serverAssignmentCount, 2);
    assert.equal(diag.assignedCampaignCount, 2);
    assert.ok(diag.snapshotSyncStatus !== undefined);
    assert.equal(diag.serverDurableAck, false);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(node.sqlite.getAssignment("tenant-a", "camp-1", "fixed-node")?.rowVersion, 9);

    node.destroy();
  });
});

test("401/403 stop retries; protocol mismatch fatal", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection({
      handler: async () => {
        throw new SeoOpsHttpError({
          method: "POST",
          endpoint: "/api/v1/social-automation/client/keepalive/register",
          status: 401,
          contentType: "application/json",
          category: "authentication",
          serverErrorCode: "unauthorized",
          serverErrorMessage: "bad key",
        });
      },
    });
    const settings = new ClientStore(dir);
    await settings.load();
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
    node.attachSyncService(sync);
    await node.setEnabled(true);
    assert.equal(sync.getState().registrationStatus, "auth_blocked");
    assert.match(sync.getState().lastHttpError ?? "", /bad key|Xác thực|unauthorized|401/i);
    node.destroy();
  });

  await withTempDir(async (dir) => {
    const conn = createMockConnection({
      handler: async () =>
        envelope({
          protocol_version: "keepalive.v9",
          schema_version: 2,
          node_id: "x",
          registered: true,
        }),
    });
    // Force node id
    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "x" });
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
    node.attachSyncService(sync);
    await node.setEnabled(true);
    assert.equal(sync.getState().registrationStatus, "protocol_mismatch");
    node.destroy();
  });
});

test("empty assignments revoke observation; generation bump; revocation", async () => {
  await withTempDir(async (dir) => {
    const sqliteBoot = await (async () => {
      const settings = new ClientStore(dir);
      await settings.load();
      await settings.set({ keepAliveNodeId: "n1" });
      const node = new KeepAliveNodeService(dir, settings);
      await node.initialize();
      await node.assignCampaign({
        tenantId: "t1",
        campaignId: "c1",
        assignmentGeneration: 1,
        rowVersion: 1,
      });
      await node.assignCampaign({
        tenantId: "t1",
        campaignId: "c2",
        assignmentGeneration: 1,
        rowVersion: 1,
      });
      return node;
    })();

    // generation bump
    let outcome = applyServerAssignments(sqliteBoot.sqlite, {
      nodeId: "n1",
      tenantId: "t1",
      assignments: [
        { campaignId: "c1", assignmentGeneration: 5, rowVersion: 2, status: "assigned" },
        { campaignId: "c2", assignmentGeneration: 1, rowVersion: 1, status: "assigned" },
      ],
    });
    assert.equal(outcome.applied, 2);
    assert.equal(sqliteBoot.sqlite.getAssignment("t1", "c1", "n1")?.assignmentGeneration, 5);

    // stale generation rejected
    outcome = applyServerAssignments(sqliteBoot.sqlite, {
      nodeId: "n1",
      tenantId: "t1",
      assignments: [
        { campaignId: "c1", assignmentGeneration: 2, rowVersion: 99, status: "assigned" },
        { campaignId: "c2", assignmentGeneration: 1, rowVersion: 1, status: "assigned" },
      ],
    });
    assert.ok(outcome.rejectedStale >= 1);
    assert.equal(sqliteBoot.sqlite.getAssignment("t1", "c1", "n1")?.assignmentGeneration, 5);

    // revoke c2 explicitly + empty means remove c1 observation
    outcome = applyServerAssignments(sqliteBoot.sqlite, {
      nodeId: "n1",
      tenantId: "t1",
      assignments: [{ campaignId: "c2", assignmentGeneration: 2, rowVersion: 2, status: "revoked" }],
    });
    assert.equal(sqliteBoot.sqlite.getAssignment("t1", "c1", "n1")?.status, "revoked");
    assert.equal(sqliteBoot.sqlite.getAssignment("t1", "c2", "n1")?.status, "revoked");
    // historical row still present
    assert.ok(sqliteBoot.sqlite.getAssignment("t1", "c1", "n1"));

    outcome = applyServerAssignments(sqliteBoot.sqlite, {
      nodeId: "n1",
      tenantId: "t1",
      assignments: [],
    });
    assert.equal(sqliteBoot.sqlite.listAssignments("n1", "assigned").length, 0);

    sqliteBoot.destroy();
  });
});

test("reconnect re-registers; server unavailable is non-fatal; disable revokes", async () => {
  await withTempDir(async (dir) => {
    let mode: "ok" | "down" = "ok";
    let registers = 0;
    const conn = createMockConnection({
      handler: async (subpath, method) => {
        if (mode === "down") {
          throw new Error("fetch failed");
        }
        if (method === "POST" && subpath.endsWith("/register")) {
          registers += 1;
          return envelope({ node_id: "n-re", tenant_id: "t1", registered: true });
        }
        return envelope({ node_id: "n-re", tenant_id: "t1", assignments: [] });
      },
    });

    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "n-re" });
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
    node.attachSyncService(sync);

    await node.setEnabled(true);
    assert.equal(registers, 1);
    assert.equal(sync.getState().registrationStatus, "registered");

    mode = "down";
    await sync.refreshAssignments("manual");
    assert.equal(sync.getState().registrationStatus, "registered"); // still registered; assignments failed transient
    assert.match(sync.getState().lastHttpError ?? "", /không khả dụng|unavailable|Server/i);

    mode = "ok";
    conn.setOnline(false);
    conn.setOnline(true);
    for (let i = 0; i < 50 && registers < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(registers >= 2);

    await node.assignCampaign({
      tenantId: "t1",
      campaignId: "cx",
      assignmentGeneration: 1,
    });
    await node.setEnabled(false);
    assert.equal(sync.getState().registrationStatus, "stopped");
    assert.equal(node.sqlite.listAssignments("n-re", "assigned").length, 0);

    node.destroy();
  });
});

test("HTTP API maps 403 fatal; Keep Alive works with Browser stopped (no profile mgr)", async () => {
  await withTempDir(async (dir) => {
    const conn = createMockConnection({
      handler: async () => {
        throw new SeoOpsHttpError({
          method: "POST",
          endpoint: "/keepalive/register",
          status: 403,
          contentType: "application/json",
          category: "authorization",
          serverErrorCode: "forbidden",
          serverErrorMessage: "no entitlement",
        });
      },
    });
    // Intentionally no ProfileManager / EmbeddedBrowser
    const { node, sync } = await boot(dir, conn);
    await node.setEnabled(true);
    assert.equal(sync.getState().registrationStatus, "auth_blocked");
    const diag = await node.getDiagnostics();
    assert.equal(diag.browserRequired, false);
    node.destroy();
  });
});

test("wiring: refresh IPC + no claim coupling; claim remains opt-in", async () => {
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const contracts = await readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");
  const panel = await readFile(
    new URL("../src/renderer/components/keepalive-diagnostics-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(main, /KeepAliveSyncService/);
  assert.match(main, /refreshKeepAliveAssignments/);
  assert.match(main, /RPA_CAMPAIGN_CLAIM/);
  assert.match(contracts, /refreshKeepAliveAssignments/);
  assert.match(contracts, /snapshotSyncStatus/);
  assert.match(panel, /Refresh sync/);
  assert.match(panel, /Server durable ACK/);
  assert.doesNotMatch(panel, /claimCampaign/i);
  assert.match(panel, /Local persistence ≠ durable server ACK|server ACK/i);
});

test("duplicate register for same connection is skipped", async () => {
  await withTempDir(async (dir) => {
    let registers = 0;
    const conn = createMockConnection({
      handler: async (subpath, method) => {
        if (method === "POST") {
          registers += 1;
          return envelope({ node_id: "dup", tenant_id: "t", registered: true, idempotent: true });
        }
        return envelope({ node_id: "dup", tenant_id: "t", assignments: [] });
      },
    });
    const settings = new ClientStore(dir);
    await settings.load();
    await settings.set({ keepAliveNodeId: "dup" });
    const node = new KeepAliveNodeService(dir, settings);
    await node.initialize();
    const sync = new KeepAliveSyncService(conn as never, node, new KeepAliveHttpApi(conn as never));
    node.attachSyncService(sync);
    await node.setEnabled(true);
    await sync.refreshAssignments("a");
    await sync.refreshAssignments("b");
    assert.equal(registers, 1);
    node.destroy();
  });
});

// type smoke for exported parse helpers
test("KeepAliveHttpResult discriminants compile", () => {
  const sample: KeepAliveHttpResult<KeepAliveRegisterResponse> = {
    ok: true,
    data: {
      protocolVersion: KEEPALIVE_PROTOCOL_VERSION,
      schemaVersion: KEEPALIVE_SCHEMA_VERSION,
      nodeId: "n",
      tenantId: "t",
      registered: true,
    },
  };
  const assign: KeepAliveHttpResult<KeepAliveAssignmentsResponse> = {
    ok: false,
    status: 0,
    code: "client_offline",
    message: "offline",
    fatal: false,
  };
  assert.equal(sample.ok, true);
  assert.equal(assign.ok, false);
});
