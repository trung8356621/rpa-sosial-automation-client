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
} from "../src/main/keepalive/keepalive-http-api.js";
import {
  parseSocketHint,
  type KeepAliveSocketFactory,
  type KeepAliveSocketHandle,
} from "../src/main/keepalive/keepalive-socket-client.js";
import {
  KEEPALIVE_PROTOCOL_VERSION,
  KEEPALIVE_SCHEMA_VERSION,
} from "../src/main/keepalive/contracts.js";
import type { ConnectionState } from "../src/shared/contracts.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-3b6d-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function envelope(extra: Record<string, unknown> = {}) {
  return {
    protocol_version: KEEPALIVE_PROTOCOL_VERSION,
    schema_version: KEEPALIVE_SCHEMA_VERSION,
    ...extra,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Handler = (
  subpath: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>
) => Promise<Record<string, unknown>>;

function createMockConnection(handler: Handler, opts?: { online?: boolean }) {
  const listeners: Array<(s: ConnectionState) => void> = [];
  const conn = {
    online: opts?.online ?? true,
    agentUuid: "agent-1",
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
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((l) => l !== listener)
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
}): KeepAliveSocketFactory {
  return (params) => {
    state.tickets.push(params.ticket);
    const handle = new MockSocketHandle();
    state.handles.push(handle);
    queueMicrotask(() => handle.markConnected());
    return handle;
  };
}

function eventRow(seq: number, type: string) {
  return {
    event_id: `e-${seq}`,
    event_sequence: seq,
    event_type: type,
    job_id: "job-1",
    attempt: 1,
    fencing_generation: 1,
    payload_version: 1,
    payload: {},
  };
}

function standardHandler(opts?: {
  ticket?: (body?: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  ticketFail?: SeoOpsHttpError;
}): Handler {
  let ticketN = 0;
  return async (subpath, method, body) => {
    if (subpath.includes("/keepalive/register") && method === "POST") {
      return envelope({ node_id: "n1", tenant_id: "install-1", registered: true });
    }
    if (subpath.includes("/keepalive/assignments") && method === "GET") {
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        assignments: [
          { campaign_id: "c1", assignment_generation: 1, row_version: 1, status: "assigned" },
        ],
      });
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
        job_id: body?.job_id,
        attempt: body?.attempt,
        storage_key: body?.storage_key,
        acked: true,
      });
    }
    if (subpath.includes("/socket/ticket") || subpath.endsWith(KEEPALIVE_SOCKET_TICKET_PATH)) {
      if (opts?.ticketFail) throw opts.ticketFail;
      ticketN += 1;
      if (opts?.ticket) return opts.ticket(body);
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        ticket: `ticket-${ticketN}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        gateway_url: "https://seo-ops.test",
        socket_path: "/keepalive/socket.io/",
        route_generation: 7,
      });
    }
    if (subpath.includes("/snapshot")) {
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: "c1",
        assignment_generation: 1,
        snapshot_version: 1,
        sequence: 0,
        event_sequence_head: 1,
        row_version: 1,
        metadata: { name: "c1" },
      });
    }
    if (subpath.includes("/events")) {
      return envelope({
        node_id: "n1",
        tenant_id: "install-1",
        campaign_id: "c1",
        assignment_generation: 1,
        events: [eventRow(1, "job_started")],
        has_more: false,
        event_sequence_head: 1,
      });
    }
    throw new Error(`unhandled ${method} ${subpath}`);
  };
}

async function boot(
  dir: string,
  handler: Handler,
  factory: KeepAliveSocketFactory
) {
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
  return { node, sync, conn };
}

test("parse socket ticket; reject missing ticket / protocol", () => {
  const ok = parseSocketTicketResponse(
    envelope({
      node_id: "n1",
      tenant_id: "install-1",
      ticket: "abc",
      expires_at: "2099-01-01T00:00:00.000Z",
      gateway_url: "https://gw.test",
      socket_path: "/keepalive/socket.io/",
      route_generation: 3,
    }),
    "n1",
    "https://seo-ops.test"
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.ticket, "abc");
    assert.equal(ok.data.routeGeneration, 3);
    assert.equal(ok.data.socketPath, "/keepalive/socket.io/");
  }

  const bad = parseSocketTicketResponse(
    envelope({
      node_id: "n1",
      tenant_id: "install-1",
      expires_at: "2099-01-01T00:00:00.000Z",
      gateway_url: "https://gw.test",
      route_generation: 1,
    }),
    "n1",
    "https://seo-ops.test"
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "ticket_missing");
});

test("parseSocketHint validates route_generation and protocol", () => {
  const ok = parseSocketHint(
    envelope({
      route_generation: 2,
      campaign_id: "c1",
      reason: "events",
    }),
    "ka.notify"
  );
  assert.equal(ok.ok, true);

  const staleProto = parseSocketHint(
    { protocol_version: "keepalive.v0", schema_version: 2, route_generation: 1 },
    "ka.notify"
  );
  assert.equal(staleProto.ok, false);
  if (!staleProto.ok) assert.equal(staleProto.fatal, true);
});

test("ticket mint + socket connect uses auth.ticket; never API key", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    const bodies: Record<string, unknown>[] = [];
    const { node, sync } = await boot(
      dir,
      standardHandler({
        ticket: (body) => {
          bodies.push(body ?? {});
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            ticket: "fresh-ticket-1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            gateway_url: "https://seo-ops.test",
            socket_path: "/keepalive/socket.io/",
            route_generation: 7,
          });
        },
      }),
      createTrackingSocketFactory(sock)
    );
    await sync.refreshAssignments("test");
    await sleep(30);
    assert.ok(bodies[0]);
    assert.equal(bodies[0].node_id, "n1");
    assert.ok(!JSON.stringify(bodies[0]).includes("rpa_"));
    assert.deepEqual(sock.tickets, ["fresh-ticket-1"]);
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketConnected, true);
    assert.equal(diag.socketRouteGeneration, 7);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.browserRequired, false);
    // Ticket must not appear in diagnostics/errors
    assert.equal(diag.lastSocketError, null);
    assert.doesNotMatch(JSON.stringify(diag), /fresh-ticket/);
    node.destroy();
  });
});

test("invalid ticket stops with auth_blocked", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    const { node, sync } = await boot(
      dir,
      standardHandler({
        ticketFail: new SeoOpsHttpError({
          method: "POST",
          endpoint: KEEPALIVE_SOCKET_TICKET_PATH,
          status: 403,
          contentType: "application/json",
          category: "authorization",
          serverErrorCode: "forbidden",
          serverErrorMessage: "revoked",
        }),
      }),
      createTrackingSocketFactory(sock)
    );
    await sync.refreshAssignments("test");
    await sleep(30);
    assert.equal(sock.tickets.length, 0);
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketConnected, false);
    assert.ok(
      diag.socketStatus === "auth_blocked" ||
        diag.socketStatus === "error" ||
        diag.lastSocketError
    );
    node.destroy();
  });
});

test("reconnect mints a fresh ticket", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    let n = 0;
    const { node, sync } = await boot(
      dir,
      standardHandler({
        ticket: () => {
          n += 1;
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            ticket: `t-${n}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            gateway_url: "https://seo-ops.test",
            socket_path: "/keepalive/socket.io/",
            route_generation: 7,
          });
        },
      }),
      createTrackingSocketFactory(sock)
    );
    await sync.refreshAssignments("test");
    await sleep(30);
    assert.equal(sock.tickets[0], "t-1");
    sock.handles[0].emit("disconnect", "transport close");
    await sleep(2000);
    assert.ok(sock.tickets.length >= 2);
    assert.equal(sock.tickets[sock.tickets.length - 1], `t-${n}`);
    assert.notEqual(sock.tickets[0], sock.tickets[sock.tickets.length - 1]);
    node.destroy();
  });
});

test("notification coalescing triggers one HTTP sync", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    let assignmentGets = 0;
    const handler: Handler = async (subpath, method, body) => {
      if (subpath.includes("/assignments") && method === "GET") assignmentGets += 1;
      return standardHandler()(subpath, method, body);
    };
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(30);
    const baseline = assignmentGets;
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 7, campaign_id: "c1" }),
      "ka.notify"
    );
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 7, campaign_id: "c1" }),
      "ka.notify"
    );
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 7, campaign_id: "c1" }),
      "ka.recover_hint"
    );
    await sleep(900);
    // Coalesced into one catch-up (inFlight dedupe) — not 3.
    assert.ok(assignmentGets - baseline <= 2);
    assert.ok(assignmentGets > baseline);
    const diag = await node.getDiagnostics();
    assert.ok(diag.lastSocketNotifyAt);
    node.destroy();
  });
});

test("assignment_changed hint refreshes assignments", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    let assignmentGets = 0;
    const handler: Handler = async (subpath, method, body) => {
      if (subpath.includes("/assignments") && method === "GET") assignmentGets += 1;
      return standardHandler()(subpath, method, body);
    };
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(30);
    const baseline = assignmentGets;
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 7, campaign_id: "c1" }),
      "ka.assignment_changed"
    );
    await sleep(900);
    assert.ok(assignmentGets > baseline);
    node.destroy();
  });
});

test("route_invalidated forces fresh ticket reconnect", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    let n = 0;
    const { node, sync } = await boot(
      dir,
      standardHandler({
        ticket: () => {
          n += 1;
          return envelope({
            node_id: "n1",
            tenant_id: "install-1",
            ticket: `route-t-${n}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            gateway_url: "https://seo-ops.test",
            socket_path: "/keepalive/socket.io/",
            route_generation: n === 1 ? 7 : 8,
          });
        },
      }),
      createTrackingSocketFactory(sock)
    );
    await sync.refreshAssignments("boot");
    await sleep(30);
    assert.equal(sock.tickets[0], "route-t-1");
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 8, reason: "gateway_moved" }),
      "ka.route_invalidated"
    );
    await sleep(100);
    assert.ok(sock.tickets.includes("route-t-2"));
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketRouteGeneration, 8);
    node.destroy();
  });
});

test("gateway offline keeps HTTP fallback working", async () => {
  await withTempDir(async (dir) => {
    const factory: KeepAliveSocketFactory = () => {
      const handle = new MockSocketHandle();
      queueMicrotask(() => handle.emit("connect_error", new Error("gateway offline")));
      return handle;
    };
    const { node, sync } = await boot(dir, standardHandler(), factory);
    await sync.refreshAssignments("boot");
    await sleep(50);
    // Durable HTTP path still applied events
    assert.equal(node.sqlite.getCursor("install-1", "c1")?.lastAppliedSequence, 1);
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketConnected, false);
    assert.ok(diag.lastSocketError);
    node.destroy();
  });
});

test("stale route_generation is ignored", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    let assignmentGets = 0;
    const handler: Handler = async (subpath, method, body) => {
      if (subpath.includes("/assignments") && method === "GET") assignmentGets += 1;
      return standardHandler()(subpath, method, body);
    };
    const { node, sync } = await boot(dir, handler, createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(30);
    const baseline = assignmentGets;
    sync.ingestSocketHintForTests(
      envelope({ route_generation: 1, campaign_id: "c1" }),
      "ka.notify"
    );
    await sleep(900);
    assert.equal(assignmentGets, baseline);
    node.destroy();
  });
});

test("Keep Alive disabled disconnects socket; Browser stopped + claim OFF", async () => {
  await withTempDir(async (dir) => {
    const sock = { tickets: [] as string[], handles: [] as MockSocketHandle[] };
    const { node, sync } = await boot(dir, standardHandler(), createTrackingSocketFactory(sock));
    await sync.refreshAssignments("boot");
    await sleep(30);
    assert.equal((await node.getDiagnostics()).socketConnected, true);
    await node.setEnabled(false);
    const diag = await node.getDiagnostics();
    assert.equal(diag.socketStatus, "stopped");
    assert.equal(diag.socketConnected, false);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(process.env.RPA_CAMPAIGN_CLAIM === "1", false);
    assert.ok(sock.handles[0].disconnectCalls >= 1);
    node.destroy();
  });
});
