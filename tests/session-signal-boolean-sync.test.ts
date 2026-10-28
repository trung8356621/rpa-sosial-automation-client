import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSyncService, sanitizeProfilesForSync } from "../src/main/browser/browser-sync-service.js";
import type { BrowserProfile } from "../src/shared/contracts.js";
import {
  mergeSessionSignalLastWriteWins,
  normalizeSessionSignal,
  shouldApplyRemoteSignal,
  signalIsPresent,
} from "../src/shared/session-signal-sync.js";

function profile(browserId: string, checkedAt: string, status: "present" | "absent"): BrowserProfile {
  return {
    browserId,
    name: `P-${browserId.slice(0, 8)}`,
    platform: "facebook",
    partition: `persist:rpa-client-${browserId}`,
    status: "stopped",
    accountBinding: {
      accountId: `820c2507-1ef8-46f2-a59e-${browserId.slice(0, 12).padEnd(12, "0")}`,
      boundAt: "2026-10-26T12:00:00Z",
      accountName: "Acc",
    },
    sessionSignal: {
      status,
      checkedAt,
      method: "facebook_c_user_cookie",
    },
    createdAt: "2026-10-26T12:00:00Z",
    updatedAt: "2026-10-26T12:00:00Z",
  };
}

test("A: client true payload includes present boolean for SEO-OPS", () => {
  const sanitized = sanitizeProfilesForSync([
    profile("b3f36077-9ca6-4d26-a94f-a7f45b331001", "2026-10-27T10:00:05.000Z", "present"),
  ]);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].session_signal.present, true);
  assert.equal(sanitized[0].session_signal.status, "present");
  assert.equal(sanitized[0].session_signal.checked_at, "2026-10-27T10:00:05.000Z");
});

test("B/C: LWW apply — SEO-OPS false then client recheck true", () => {
  const localTrue = normalizeSessionSignal({
    status: "present",
    checked_at: "2026-10-27T10:00:00.000Z",
    method: "facebook_c_user_cookie",
  });
  const adminFalse = normalizeSessionSignal({
    present: false,
    checked_at: "2026-10-27T10:00:10.000Z",
  });
  assert.equal(signalIsPresent(mergeSessionSignalLastWriteWins(localTrue, adminFalse)), false);

  const recheckTrue = normalizeSessionSignal({
    status: "present",
    checked_at: "2026-10-27T10:00:20.000Z",
    method: "facebook_c_user_cookie",
  });
  assert.equal(signalIsPresent(mergeSessionSignalLastWriteWins(adminFalse, recheckTrue)), true);
});

test("D/E: remote apply updates only matching browser ids (restart/heartbeat path)", async () => {
  const updates: Array<{ id: string; status: string }> = [];
  const profiles = new Map<string, BrowserProfile>([
    ["b3f36077-9ca6-4d26-a94f-a7f45b3310a1", profile("b3f36077-9ca6-4d26-a94f-a7f45b3310a1", "2026-10-27T09:00:00.000Z", "present")],
    ["b3f36077-9ca6-4d26-a94f-a7f45b3310b2", profile("b3f36077-9ca6-4d26-a94f-a7f45b3310b2", "2026-10-27T09:00:00.000Z", "present")],
  ]);

  const connection = {
    onStateChange: () => () => undefined,
    onHeartbeatResponse: () => () => undefined,
    isOnline: () => true,
    requestWithAuth: async () => ({ ok: true }),
  };
  const profileManager = {
    list: () => [...profiles.values()],
    get: (id: string) => profiles.get(id),
    refreshAccountMetadata: async () => undefined,
    updateSessionSignal: async (browserId: string, signal: BrowserProfile["sessionSignal"]) => {
      const p = profiles.get(browserId);
      if (!p || !signal) return;
      p.sessionSignal = { ...signal, method: "facebook_c_user_cookie" };
      updates.push({ id: browserId, status: signal.status });
    },
  };

  const service = new BrowserSyncService(connection as never, profileManager as never);
  const applied = await service.applyRemoteSessionSignals([
    {
      browser_id: "b3f36077-9ca6-4d26-a94f-a7f45b3310a1",
      present: false,
      status: "absent",
      checked_at: "2026-10-27T09:30:00.000Z",
    },
    {
      browser_id: "b3f36077-9ca6-4d26-a94f-a7f45b3310b2",
      present: true,
      status: "present",
      checked_at: "2026-10-27T09:00:00.000Z",
    },
  ]);

  assert.equal(applied, 1);
  assert.deepEqual(updates, [{ id: "b3f36077-9ca6-4d26-a94f-a7f45b3310a1", status: "absent" }]);
  assert.equal(profiles.get("b3f36077-9ca6-4d26-a94f-a7f45b3310a1")?.sessionSignal?.status, "absent");
  assert.equal(profiles.get("b3f36077-9ca6-4d26-a94f-a7f45b3310b2")?.sessionSignal?.status, "present");
});

test("F: sync upload and remote apply do not require ACK or task confirmation fields", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const connection = {
    onStateChange: () => () => undefined,
    onHeartbeatResponse: () => () => undefined,
    isOnline: () => true,
    requestWithAuth: async (path: string, _method: string, body?: Record<string, unknown>) => {
      if (path.includes("/accounts/")) {
        return {
          ok: true,
          account: {
            account_id: "820c2507-1ef8-46f2-a59e-b3f360770000",
            platform: "facebook",
            display_name: "Acc",
            email: null,
            password_status: "unavailable",
          },
        };
      }
      bodies.push(body || {});
      return {
        ok: true,
        browsers: [],
        session_signals: [
          {
            browser_id: "b3f36077-9ca6-4d26-a94f-a7f45b331001",
            present: true,
            status: "present",
            checked_at: "2026-10-27T10:00:05.000Z",
          },
        ],
      };
    },
  };

  const local = profile("b3f36077-9ca6-4d26-a94f-a7f45b331001", "2026-10-27T10:00:05.000Z", "present");
  const profileManager = {
    list: () => [local],
    get: (id: string) => (id === local.browserId ? local : undefined),
    refreshAccountMetadata: async () => undefined,
    updateSessionSignal: async () => undefined,
  };

  const service = new BrowserSyncService(connection as never, profileManager as never);
  assert.equal(await service.syncAll(), true);
  const uploaded = bodies[0]?.browsers as Array<{ session_signal: Record<string, unknown> }>;
  assert.equal(uploaded[0].session_signal.present, true);
  assert.equal("ack" in uploaded[0].session_signal, false);
  assert.equal("session_state" in uploaded[0], false);
  assert.equal("execution_confirmation" in uploaded[0].session_signal, false);
});

test("shouldApplyRemoteSignal is false when remote is older", () => {
  const local = normalizeSessionSignal({ status: "present", checked_at: "2026-10-27T12:00:00.000Z" });
  const olderRemote = normalizeSessionSignal({ present: false, checked_at: "2026-10-27T11:00:00.000Z" });
  assert.equal(shouldApplyRemoteSignal(local, olderRemote), false);
});
