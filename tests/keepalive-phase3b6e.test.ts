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
  KEEPALIVE_SOCKET_TICKET_PATH,
  parseSocketTicketResponse,
  resolveGatewayUrlAndPath,
} from "../src/main/keepalive/keepalive-http-api.js";
import {
  parseSocketHint,
  type KeepAliveSocketFactory,
  type KeepAliveSocketHandle,
} from "../src/main/keepalive/keepalive-socket-client.js";
import {
  KEEPALIVE_SOCKET_ENVELOPE_V,
  KEEPALIVE_SOCKET_PATH_DEFAULT,
} from "../src/main/keepalive/contracts.js";
import type { ConnectionState } from "../src/shared/contracts.js";

/**
 * Exact 3B.6E server contract fixtures (freeze @ 56bc338).
 * Flattened ticket + envelope { v:2, t } with nullable fields.
 */

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-3b6e-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exact flattened ticket response shape from server contract freeze. */
function serverTicketFixture(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "ka_ticket_exact_1",
    node_id: "n1",
    tenant_id: "install-1",
    role: "recovery",
    assignment_generation: 3,
    route_generation: 7,
    expires_at: "2099-01-01T00:00:00.000Z",
    gateway_url: "/keepalive/socket.io/",
    ...overrides,
  };
}

/** Exact envelope v=2 hint. */
function serverEnvelope(
  t: string,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    v: KEEPALIVE_SOCKET_ENVELOPE_V,
    t,
    node_id: null,
    route_generation: null,
    assignment_generation: null,
    reason: null,
    ...fields,
  };
}

type Handler = (
  subpath: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>
) => Promise<Record<string, unknown>>;

function createMockConnection(handler: Handler) {
  return {
    online: true,
    agentUuid: "agent-1",
    requestWithAuth: handler,
    isOnline() {
      return this.online;
    },
    getState(): ConnectionState {
      return {
        status: "connected",
        endpoint: "https://seo-ops.test",
        hasKey: true,
        agentUuid: this.agentUuid,
        clientApiKeyId: 1,
        online: true,
      };
    },
    onStateChange(listener: (s: ConnectionState) => void) {
      listener(this.getState());
      return () => undefined;
    },
  };
}

class MockSocketHandle implements KeepAliveSocketHandle {
  connected = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  disconnectCalls = 0;
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== listener)
    );
  }
  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit("disconnect", "io client disconnect");
    this.listeners.clear();
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  markConnected(): void {
    this.connected = true;
    this.emit("connect");
  }
}

function createTrackingSocketFactory(state: {
  tickets: string[];
  handles: MockSocketHandle[];
  paths: string[];
  urls: string[];
}): KeepAliveSocketFactory {
  return (params) => {
    state.tickets.push(params.ticket);
    state.paths.push(params.socketPath);
    state.urls.push(params.gatewayUrl);
    const handle = new MockSocketHandle();
    state.handles.push(handle);
    queueMicrotask(() => handle.markConnected());
    return handle;
  };
}

function syncHandler(opts?: {
  onTicket?: (body: Record<string, unknown>) => Record<string, unknown>;
  ticketResponses?: Array<Record<string, unknown>>;
}): { handler: Handler; ticketBodies: Record<string, unknown>[] } {
  const ticketBodies: Record<string, unknown>[] = [];
  let ticketIdx = 0;
  const handler: Handler = async (subpath, method, body) => {
    if (subpath.includes("/keepalive/register") && method === "POST") {
      return {
        protocol_version: "keepalive.v1",
        schema_version: 2,
        node_id: "n1",
        tenant_id: "install-1",
        registered: true,
      };
    }
    if (subpath.includes("/keepalive/assignments") && method === "GET") {
      return {
        protocol_version: "keepalive.v1",
        schema_version: 2,
        node_id: "n1",
        tenant_id: "install-1",
        assignments: [
          {
            campaign_id: "c1",
            assignment_generation: 3,
            row_version: 1,
            status: "assigned",
          },
        ],
      };
    }
    if (subpath.includes("/socket/ticket") || subpath.endsWith(KEEPALIVE_SOCKET_TICKET_PATH)) {
      ticketBodies.push({ ...(body ?? {}) });
      if (opts?.onTicket) return opts.onTicket(body ?? {});
      const canned = opts?.ticketResponses?.[ticketIdx++];
      return canned ?? serverTicketFixture({ ticket: `ka_ticket_${ticketIdx || 1}` });
    }
    if (subpath.includes("/events/ack") || subpath.includes("/artifacts/ack")) {
      return {
        protocol_version: "keepalive.v1",
        schema_version: 2,
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: body?.campaign_id,
        last_contiguous_sequence: body?.last_contiguous_sequence ?? 0,
        acked_event_ids: body?.event_ids ?? [],
        acked: true,
      };
    }
    if (subpath.includes("/snapshot")) {
      return {
        protocol_version: "keepalive.v1",
        schema_version: 2,
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: "c1",
        assignment_generation: 3,
        snapshot_version: 1,
        sequence: 0,
        event_sequence_head: 0,
        row_version: 1,
        metadata: { name: "c1" },
      };
    }
    if (subpath.includes("/events")) {
      return {
        protocol_version: "keepalive.v1",
        schema_version: 2,
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: "c1",
        assignment_generation: 3,
        events: [],
        has_more: false,
        event_sequence_head: 0,
      };
    }
    throw new Error(`unhandled ${method} ${subpath}`);
  };
  return { handler, ticketBodies };
}

async function boot(dir: string, handler: Handler, factory: KeepAliveSocketFactory) {
  const conn = createMockConnection(handler);
  const settings = new ClientStore(dir);
  await settings.load();
  await settings.set({ keepAliveNodeId: "n1", keepAlive24x7Enabled: true });
  const node = new KeepAliveNodeService(dir, settings);
  await node.initialize();
  const sync = new KeepAliveSyncService(
    conn as never,
    node,
    new KeepAliveHttpApi(conn as never),
    factory
  );
  node.attachSyncService(sync);
  return { node, sync };
}

test("resolveGatewayUrlAndPath: path hint vs full origin", () => {
  const pathHint = resolveGatewayUrlAndPath("/keepalive/socket.io/", "https://seo-ops.test");
  assert.deepEqual(pathHint, {
    gatewayUrl: "https://seo-ops.test",
    socketPath: "/keepalive/socket.io/",
  });

  const barePath = resolveGatewayUrlAndPath("/keepalive", "https://seo-ops.test/api");
  assert.equal(barePath?.gatewayUrl, "https://seo-ops.test");
  assert.equal(barePath?.socketPath, KEEPALIVE_SOCKET_PATH_DEFAULT);

  const full = resolveGatewayUrlAndPath(
    "https://gw.example.com/keepalive/socket.io/",
    "https://seo-ops.test"
  );
  assert.deepEqual(full, {
    gatewayUrl: "https://gw.example.com",
    socketPath: "/keepalive/socket.io/",
  });

  const empty = resolveGatewayUrlAndPath("", "https://seo-ops.test");
  assert.equal(empty?.gatewayUrl, "https://seo-ops.test");
  assert.equal(empty?.socketPath, KEEPALIVE_SOCKET_PATH_DEFAULT);
});

test("parse flattened ticket fixture (exact server JSON)", () => {
  const parsed = parseSocketTicketResponse(
    serverTicketFixture(),
    "n1",
    "https://seo-ops.test"
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.ticket, "ka_ticket_exact_1");
    assert.equal(parsed.data.gatewayUrl, "https://seo-ops.test");
    assert.equal(parsed.data.socketPath, "/keepalive/socket.io/");
    assert.equal(parsed.data.gatewayUrlRaw, "/keepalive/socket.io/");
    assert.equal(parsed.data.routeGeneration, 7);
    assert.equal(parsed.data.assignmentGeneration, 3);
    assert.equal(parsed.data.role, "recovery");
    assert.equal(parsed.data.protocolVersion, null);
  }
});

test("parse envelope v=2 with nullable fields + seq_hint", () => {
  const notify = parseSocketHint(
    serverEnvelope("ka.notify", {
      campaign_id: "c1",
      seq_hint: 42,
      node_id: null,
      route_generation: null,
      assignment_generation: null,
      reason: null,
    }),
    "ka.notify"
  );
  assert.equal(notify.ok, true);
  if (notify.ok) {
    assert.equal(notify.hint.event, "ka.notify");
    assert.equal(notify.hint.seqHint, 42);
    assert.equal(notify.hint.routeGeneration, null);
    assert.equal(notify.hint.nodeId, null);
    assert.equal(notify.hint.assignmentGeneration, null);
    assert.equal(notify.hint.reason, null);
  }

  const badV = parseSocketHint(serverEnvelope("ka.notify", { v: 9 }), "ka.notify");
  assert.equal(badV.ok, false);
  if (!badV.ok) assert.equal(badV.fatal, true);
});

test("ticket mint body: role=recovery + assignment_generation + campaign_ids", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[], paths: [] as string[], urls: [] as string[] };
    const { handler, ticketBodies } = syncHandler();
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("test");
    await sleep(40);
    assert.ok(ticketBodies.length >= 1);
    assert.equal(ticketBodies[0].role, "recovery");
    assert.equal(ticketBodies[0].node_id, "n1");
    assert.equal(ticketBodies[0].assignment_generation, 3);
    assert.deepEqual(ticketBodies[0].campaign_ids, ["c1"]);
    assert.equal(sock.paths[0], "/keepalive/socket.io/");
    assert.equal(sock.urls[0], "https://seo-ops.test");
    assert.equal((await node.getDiagnostics()).socketConnected, true);
    node.destroy();
  });
});

test("reconnect re-mints fresh flattened ticket", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[], paths: [] as string[], urls: [] as string[] };
    let n = 0;
    const { handler } = syncHandler({
      onTicket: () => {
        n += 1;
        return serverTicketFixture({ ticket: `remint-${n}`, route_generation: 7 });
      },
    });
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(40);
    assert.equal(sock.tickets[0], "remint-1");
    sock.handles[0].emit("disconnect", "transport close");
    await sleep(2000);
    assert.ok(sock.tickets.length >= 2);
    assert.notEqual(sock.tickets[0], sock.tickets[sock.tickets.length - 1]);
    node.destroy();
  });
});

test("nullable route_generation accepted; stale concrete route ignored", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[], paths: [] as string[], urls: [] as string[] };
    let assignmentGets = 0;
    const base = syncHandler();
    const handler: Handler = async (subpath, method, body) => {
      if (subpath.includes("/assignments") && method === "GET") assignmentGets += 1;
      return base.handler(subpath, method, body);
    };
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(40);
    const baseline = assignmentGets;

    // Nullable route — accepted, coalesced sync
    sync.ingestSocketHintForTests(
      serverEnvelope("ka.notify", { campaign_id: "c1", route_generation: null }),
      "ka.notify"
    );
    await sleep(900);
    assert.ok(assignmentGets > baseline);

    const afterNullable = assignmentGets;
    // Stale concrete route vs ticket route_generation=7
    sync.ingestSocketHintForTests(
      serverEnvelope("ka.notify", { campaign_id: "c1", route_generation: 1 }),
      "ka.notify"
    );
    await sleep(900);
    assert.equal(assignmentGets, afterNullable);
    node.destroy();
  });
});

test("route_generation bump triggers re-mint", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[], paths: [] as string[], urls: [] as string[] };
    let n = 0;
    const { handler } = syncHandler({
      onTicket: () => {
        n += 1;
        return serverTicketFixture({
          ticket: `route-${n}`,
          route_generation: n === 1 ? 7 : 9,
        });
      },
    });
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(40);
    sync.ingestSocketHintForTests(
      serverEnvelope("ka.route_invalidated", {
        route_generation: 9,
        reason: "moved",
      }),
      "ka.route_invalidated"
    );
    await sleep(120);
    assert.ok(sock.tickets.includes("route-2"));
    assert.equal((await node.getDiagnostics()).socketRouteGeneration, 9);
    node.destroy();
  });
});

test("missing optional ka.recover_hint is fine; assignment_changed works", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[], paths: [] as string[], urls: [] as string[] };
    let assignmentGets = 0;
    const base = syncHandler();
    const handler: Handler = async (subpath, method, body) => {
      if (subpath.includes("/assignments") && method === "GET") assignmentGets += 1;
      return base.handler(subpath, method, body);
    };
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(40);
    const baseline = assignmentGets;
    // Server does not emit recover_hint — only assignment_changed
    sync.ingestSocketHintForTests(
      serverEnvelope("ka.assignment_changed", {
        route_generation: 7,
        assignment_generation: 3,
        campaign_id: "c1",
      }),
      "ka.assignment_changed"
    );
    await sleep(900);
    assert.ok(assignmentGets > baseline);
    // seq_hint must not advance SQLite applied cursor
    const before = node.sqlite.getCursor("install-1", "c1")?.lastAppliedSequence ?? 0;
    sync.ingestSocketHintForTests(
      serverEnvelope("ka.notify", { seq_hint: 999, route_generation: 7 }),
      "ka.notify"
    );
    await sleep(900);
    const after = node.sqlite.getCursor("install-1", "c1")?.lastAppliedSequence ?? 0;
    assert.equal(after, before);
    node.destroy();
  });
});

test("gateway offline — HTTP sync still works; claim OFF", async () => {
  await withTempDir(async (dir) => {
    const factory: KeepAliveSocketFactory = () => {
      const handle = new MockSocketHandle();
      queueMicrotask(() => handle.emit("connect_error", new Error("gateway offline")));
      return handle;
    };
    const { handler } = syncHandler();
    const { node, sync } = await boot(dir, handler, factory);
    await sync.refreshAssignments("boot");
    await sleep(50);
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketConnected, false);
    assert.ok(diag.lastSocketError);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.phase, "socket-hints");
    node.destroy();
  });
});
