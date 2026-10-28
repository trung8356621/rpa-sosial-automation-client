import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("notification orchestrator polls in main and dedupes toast by UUID", async () => {
  const source = await readFile(new URL("../src/main/app/notification-orchestrator.ts", import.meta.url), "utf8");
  assert.match(source, /toastedIds/);
  assert.match(source, /dismissedIds/);
  assert.match(source, /pendingAckIds/);
  assert.match(source, /markSeen\(/);
  assert.match(source, /flushPendingAcks/);
  assert.match(source, /Notification\.isSupported/);
  assert.match(source, /showMainWindow/);
  assert.match(source, /POLL_INTERVAL_MS = 30_000/);
  assert.doesNotMatch(source, /confirmLogin|syncAll|needs_login|session_state/);
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
    acknowledgeNotification: async () => true,
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

test("markSeen hides immediately and does not resurface on poll; ACK retries after failure", async () => {
  let canRunRuntime = false;
  try {
    const electron = await import("electron");
    canRunRuntime = typeof (electron as { Notification?: unknown }).Notification === "function";
  } catch {
    canRunRuntime = false;
  }
  if (!canRunRuntime) return;

  const { NotificationOrchestrator } = await import("../src/main/app/notification-orchestrator.js");

  const rows = [
    {
      id: "n-login",
      type: "login_required",
      message: "Re-login",
      account_name: "Acc",
      account_id: "a1",
      browser_id: "b1",
    },
  ];

  let ackCalls = 0;
  let ackShouldFail = true;
  const connection = {
    onStateChange: () => () => undefined,
    isOnline: () => true,
  };
  const syncService = {
    getNotifications: async () => rows,
    acknowledgeNotification: async () => {
      ackCalls += 1;
      if (ackShouldFail) throw new Error("network down");
      return true;
    },
  };

  const broadcasts: number[] = [];
  const orchestrator = new NotificationOrchestrator(
    connection as never,
    syncService as never,
    () => undefined,
    (list) => {
      broadcasts.push(list.length);
    },
  );

  await orchestrator.poll("connect");
  assert.equal(orchestrator.getPending().length, 1);

  const afterSeen = orchestrator.markSeen("n-login");
  assert.equal(afterSeen.length, 0);
  assert.equal(orchestrator.getPending().length, 0);
  assert.ok(broadcasts.includes(0), "broadcast empty list after Seen");

  // Allow failed ACK attempt to settle
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ackCalls >= 1);

  // Poll while server still returns the same UUID — must stay hidden
  await orchestrator.poll("interval");
  assert.equal(orchestrator.getPending().length, 0, "Seen notification must not resurface from poll");

  ackShouldFail = false;
  await orchestrator.flushPendingAcks();
  assert.ok(ackCalls >= 2, "ACK must retry after prior failure");

  orchestrator.destroy();
});

test("main + UI use Seen-only ack; no confirmNotificationLogin coupling", async () => {
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/renderer/components/app-shell.tsx", import.meta.url), "utf8");
  const contracts = await readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");

  assert.match(main, /setAppUserModelId/);
  assert.match(main, /NotificationOrchestrator/);
  assert.match(main, /markSeen\(cmd\.notificationId\)/);
  assert.doesNotMatch(main, /confirmNotificationLogin/);
  assert.doesNotMatch(main, /ack_pending/);
  assert.doesNotMatch(contracts, /confirmNotificationLogin/);
  assert.match(shell, /Đã xem/);
  assert.doesNotMatch(shell, /Xác nhận đã đăng nhập|confirmLoginNotification|confirmNotificationLogin/);
  assert.doesNotMatch(shell, /Đã xử lý/);
});
