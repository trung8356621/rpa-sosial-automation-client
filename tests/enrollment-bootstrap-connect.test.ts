import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientConnection } from "../src/main/connection/client-connection.js";
import { looksLikeEnrollmentBootstrapKey } from "../src/main/connection/enrollment-bootstrap.js";
import { ClientStore } from "../src/main/storage/store.js";
import { ClientCredentialStore } from "../src/main/storage/credential-store.js";
import { DeviceManager } from "../src/main/device/device-manager.js";
import { formatClientHttpError, SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

/** Fixture bootstrap shape — not a real signed production key. */
const BOOTSTRAP_FIXTURE =
  "rpa_client_aabbccdd_" +
  "eyJ2IjoxLCJwdXJwb3NlIjoic3RhZmZfY2xpZW50X2Vucm9sbCIsInNpZCI6NDIsImlpZCI6Imluc190ZXN0IiwiZXhwIjoxOTk5OTk5OTk5LCJuIjoiYWJjZGVmMDEyMzQ1Njc4OSJ9" +
  "." +
  "a".repeat(64);

const LEGACY_KEY = "rpa_client_live_legacypersistedkey_abcdefghijklmnop";

type Call = { method: string; url: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withConnection(
  run: (ctx: {
    connection: ClientConnection;
    credentials: ClientCredentialStore;
    calls: Call[];
    setHandler: (fn: (method: string, url: string) => Response | Promise<Response>) => void;
  }) => Promise<void>
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "enroll-connect-"));
  const calls: Call[] = [];
  let handler: (method: string, url: string) => Response | Promise<Response> = () =>
    jsonResponse({ ok: false, error: "unexpected" }, 500);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ method, url });
    return handler(method, url);
  }) as typeof fetch;

  const store = new ClientStore(tmp);
  await store.load();
  await store.set({ endpoint: "https://seo-ops.test" });
  const credentials = new ClientCredentialStore(tmp);
  await credentials.hydrate();
  const device = new DeviceManager(tmp);
  await device.initialize();
  const connection = new ClientConnection(store, credentials, device);

  try {
    await run({
      connection,
      credentials,
      calls,
      setHandler: (fn) => {
        handler = fn;
      },
    });
  } finally {
    // Always tear down heartbeat timers.
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
    globalThis.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("looksLikeEnrollmentBootstrapKey matches CP17A shape only", () => {
  assert.equal(looksLikeEnrollmentBootstrapKey(BOOTSTRAP_FIXTURE), true);
  assert.equal(looksLikeEnrollmentBootstrapKey(`  ${BOOTSTRAP_FIXTURE}  `), true);
  assert.equal(looksLikeEnrollmentBootstrapKey(LEGACY_KEY), false);
  assert.equal(looksLikeEnrollmentBootstrapKey("rpa_client_deadbeef_not-a-bootstrap"), false);
  assert.equal(looksLikeEnrollmentBootstrapKey(""), false);
});

test("1+2. Bootstrap key → register FIRST; no pre-register validate", async () => {
  await withConnection(async ({ connection, calls, setHandler }) => {
    let phase: "before_register" | "after_register" = "before_register";
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        assert.equal(phase, "before_register");
        phase = "after_register";
        return jsonResponse({
          ok: true,
          agent: { agent_uuid: "agent-boot-1" },
          connection_token: "lease-boot-1",
        });
      }
      if (method === "GET" && url.includes("/client/validate")) {
        assert.equal(phase, "after_register", "validate only after register for bootstrap");
        return jsonResponse({
          ok: true,
          client_api_key: { id: 77, installation_id: "ins_test", key_prefix: "rpa_client_aabbccdd" },
          installation: { installation_id: "ins_test" },
        });
      }
      if (method === "POST" && url.includes("/client/disconnect")) {
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true });
    });

    const state = await connection.connect(BOOTSTRAP_FIXTURE, "https://seo-ops.test");
    assert.equal(state.status, "connected");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/client\/register$/);

    const registerIdx = calls.findIndex((c) => c.method === "POST" && c.url.includes("/client/register"));
    const firstValidateIdx = calls.findIndex((c) => c.method === "GET" && c.url.includes("/client/validate"));
    assert.ok(registerIdx >= 0);
    assert.ok(firstValidateIdx > registerIdx);
  });
});

test("3. Bootstrap registration success → connected + key persisted", async () => {
  await withConnection(async ({ connection, credentials, setHandler }) => {
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse({
          ok: true,
          agent: { agent_uuid: "agent-ok" },
          connection_token: "lease-ok",
        });
      }
      if (method === "GET" && url.includes("/client/validate")) {
        return jsonResponse({
          ok: true,
          client_api_key: { id: 9, installation_id: "ins_ok", key_prefix: "rpa_client_aabbccdd" },
          installation: { installation_id: "ins_ok" },
        });
      }
      if (method === "POST" && url.includes("/client/disconnect")) {
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true });
    });

    const state = await connection.connect(BOOTSTRAP_FIXTURE);
    assert.equal(state.status, "connected");
    assert.equal(state.online, true);
    assert.equal(state.hasConnectionToken, true);
    assert.equal(credentials.getKey(), BOOTSTRAP_FIXTURE);
    assert.ok(state.nextHeartbeatInSeconds !== undefined, "heartbeat scheduled");
  });
});

test("4. Bootstrap registration 401 → not connected; key not persisted; no heartbeat", async () => {
  await withConnection(async ({ connection, credentials, setHandler, calls }) => {
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse(
          {
            ok: false,
            error: "enrollment_bootstrap_expired",
            message: "Enrollment bootstrap Key is invalid or expired.",
          },
          401
        );
      }
      return jsonResponse({ ok: true });
    });

    await assert.rejects(() => connection.connect(BOOTSTRAP_FIXTURE), /hết hạn|expired|Bootstrap/i);
    const state = connection.getState();
    assert.notEqual(state.status, "connected");
    assert.equal(state.online, false);
    assert.equal(credentials.getKey(), null);
    assert.equal(
      calls.some((c) => c.url.includes("/heartbeat")),
      false
    );
    assert.equal(state.nextHeartbeatInSeconds, undefined);
  });
});

test("5. Bootstrap registration 409 → clear staff-slot error", async () => {
  await withConnection(async ({ connection, setHandler }) => {
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse(
          {
            ok: false,
            error: "staff_client_slot_taken",
            message: "Staff already has an active Client association.",
          },
          409
        );
      }
      return jsonResponse({ ok: true });
    });

    await assert.rejects(() => connection.connect(BOOTSTRAP_FIXTURE), /Staff đã có Client|409/);
    assert.notEqual(connection.getState().status, "connected");
  });
});

test("6. Legacy key → validate then register", async () => {
  await withConnection(async ({ connection, calls, setHandler }) => {
    setHandler((method, url) => {
      if (method === "GET" && url.includes("/client/validate")) {
        return jsonResponse({
          ok: true,
          client_api_key: { id: 3, installation_id: "ins_legacy", key_prefix: "rpa_client_live" },
          installation: { installation_id: "ins_legacy" },
        });
      }
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse({
          ok: true,
          agent: { agent_uuid: "agent-legacy" },
          connection_token: "lease-legacy",
        });
      }
      if (method === "POST" && url.includes("/client/disconnect")) {
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true });
    });

    await connection.connect(LEGACY_KEY);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/client\/validate$/);
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].url, /\/client\/register$/);
    assert.equal(connection.getState().status, "connected");
    assert.equal(connection.getState().clientApiKeyId, 3);
  });
});

test("7+8. Successful enroll schedules heartbeat; failed enroll never schedules", async () => {
  await withConnection(async ({ connection, setHandler, calls }) => {
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse({
          ok: true,
          agent: { agent_uuid: "a1" },
          connection_token: "t1",
        });
      }
      if (method === "GET" && url.includes("/client/validate")) {
        return jsonResponse({
          ok: true,
          client_api_key: { id: 1, installation_id: "ins" },
          installation: { installation_id: "ins" },
        });
      }
      if (method === "POST" && url.includes("/client/disconnect")) {
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true });
    });
    await connection.connect(BOOTSTRAP_FIXTURE);
    assert.ok(connection.getState().nextHeartbeatInSeconds !== undefined);
    assert.equal(calls.some((c) => c.url.includes("/heartbeat")), false);
  });

  await withConnection(async ({ connection, setHandler, calls }) => {
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        return jsonResponse({ ok: false, error: "invalid_enrollment_bootstrap", message: "bad" }, 401);
      }
      return jsonResponse({ ok: true });
    });
    await assert.rejects(() => connection.connect(BOOTSTRAP_FIXTURE));
    assert.equal(connection.getState().nextHeartbeatInSeconds, undefined);
    assert.equal(calls.some((c) => c.url.includes("/heartbeat")), false);
  });
});

test("9. Restart with materialized key reconnects (bootstrap-shaped persisted key)", async () => {
  await withConnection(async ({ connection, credentials, setHandler }) => {
    let registers = 0;
    setHandler((method, url) => {
      if (method === "POST" && url.includes("/client/register")) {
        registers += 1;
        return jsonResponse({
          ok: true,
          agent: { agent_uuid: "agent-restart" },
          connection_token: "lease-restart",
        });
      }
      if (method === "GET" && url.includes("/client/validate")) {
        return jsonResponse({
          ok: true,
          client_api_key: { id: 12, installation_id: "ins" },
          installation: { installation_id: "ins" },
        });
      }
      if (method === "POST" && url.includes("/client/disconnect")) {
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true });
    });

    await connection.connect(BOOTSTRAP_FIXTURE);
    assert.equal(credentials.getKey(), BOOTSTRAP_FIXTURE);

    await connection.connect(credentials.getKey()!);
    assert.ok(registers >= 2);
    assert.equal(connection.getState().status, "connected");
  });
});

test("10. Revoked key → connection rejected", async () => {
  await withConnection(async ({ connection, setHandler }) => {
    setHandler((method, url) => {
      if (method === "GET" && url.includes("/client/validate")) {
        return jsonResponse({ ok: false, error: "key_revoked", message: "revoked" }, 401);
      }
      return jsonResponse({ ok: true });
    });
    await assert.rejects(() => connection.connect(LEGACY_KEY), /thu hồi|Revoked/i);
    assert.notEqual(connection.getState().status, "connected");
  });
});

test("Error formatting differentiates enrollment failures", () => {
  const expired = new SeoOpsHttpError({
    method: "POST",
    endpoint: "/api/v1/social-automation/client/register",
    status: 401,
    contentType: "application/json",
    category: "authentication",
    serverErrorCode: "enrollment_bootstrap_expired",
  });
  assert.match(formatClientHttpError(expired), /hết hạn/i);

  const slot = new SeoOpsHttpError({
    method: "POST",
    endpoint: "/api/v1/social-automation/client/register",
    status: 409,
    contentType: "application/json",
    category: "unexpected_response",
    serverErrorCode: "staff_client_slot_taken",
    serverErrorMessage: "Staff already has an active Client association.",
  });
  assert.match(formatClientHttpError(slot), /Staff đã có Client/);

  const mismatch = new SeoOpsHttpError({
    method: "POST",
    endpoint: "/api/v1/social-automation/client/register",
    status: 403,
    contentType: "application/json",
    category: "authorization",
    serverErrorCode: "enrollment_installation_mismatch",
  });
  assert.match(formatClientHttpError(mismatch), /Installation/);
});

test("11. Auth Script pipeline module still present (regression anchor)", async () => {
  const orch = await import("../src/main/auth/browser-open-orchestrator.js");
  const resolver = await import("../src/main/auth/auth-script-resolver.js");
  assert.ok(orch.BrowserOpenOrchestrator);
  assert.ok(resolver.AuthScriptResolver);
});
