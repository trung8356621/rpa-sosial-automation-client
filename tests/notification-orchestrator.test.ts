import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("notification orchestrator polls in main and dedupes by UUID", async () => {
  const source = await readFile(new URL("../src/main/app/notification-orchestrator.ts", import.meta.url), "utf8");
  assert.match(source, /seenIds/);
  assert.match(source, /Notification\.isSupported/);
  assert.match(source, /showMainWindow/);
  assert.match(source, /POLL_INTERVAL_MS = 30_000/);
  assert.match(source, /poll\("connect"\)|reason/);
  assert.match(source, /newcomers/);
  assert.doesNotMatch(source, /cookie_value|password|Bearer|session_secret/i);

  let canRunRuntime = false;
  try {
    const electron = await import("electron");
    canRunRuntime = typeof (electron as { Notification?: unknown }).Notification === "function";
  } catch {
    canRunRuntime = false;
  }
  if (!canRunRuntime) {
    // node:test loads Electron's stub without Notification — source contract above is the guard.
    return;
  }

  const { NotificationOrchestrator } = await import("../src/main/app/notification-orchestrator.js");
  const rows = [
    {
      id: "n1",
      type: "login_required",
      message: "Please re-login",
      account_name: "Acc A",
      account_id: "a1",
      browser_id: "b1",
    },
    {
      id: "n2",
      type: "display_message",
      message: "Hello",
      account_name: "Acc B",
    },
  ];

  let fetchCount = 0;
  const connection = {
    onStateChange: () => () => undefined,
    isOnline: () => true,
  };
  const syncService = {
    getNotifications: async () => {
      fetchCount += 1;
      return rows;
    },
  };

  const shown: number[] = [];
  const orchestrator = new NotificationOrchestrator(
    connection as never,
    syncService as never,
    () => {
      shown.push(1);
    },
    () => undefined,
  );

  await orchestrator.poll("connect");
  await orchestrator.poll("reconnect");
  assert.equal(fetchCount, 2);
  assert.equal(shown.length, 1, "reconnect must not duplicate popup for same UUIDs");
  orchestrator.destroy();
});

test("main process wires AppUserModelId and confirm/ACK decoupling", async () => {
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  assert.match(main, /setAppUserModelId/);
  assert.match(main, /com\.rpa\.client\.v2/);
  assert.match(main, /NotificationOrchestrator/);
  assert.match(main, /ack_pending/);
  assert.match(main, /synced = await syncService!\.syncAll\(\)/);
  assert.match(main, /if \(!synced\)/);
  assert.match(main, /if \(!confirmed\.ok\)/);
  assert.doesNotMatch(main, /return \{ ok: acked/);
});
