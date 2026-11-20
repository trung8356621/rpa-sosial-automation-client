import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientStore } from "../src/main/storage/store.js";
import { KeepAliveSqliteStore } from "../src/main/keepalive/keepalive-sqlite.js";
import { KeepAliveNodeService } from "../src/main/keepalive/keepalive-node.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keepalive-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("enable/disable Keep Alive persists across ClientStore reload", async () => {
  await withTempDir(async (dir) => {
    const store1 = new ClientStore(dir);
    await store1.load();
    assert.equal(store1.get().keepAlive24x7Enabled, undefined);

    const node1 = new KeepAliveNodeService(dir, store1);
    await node1.initialize();
    assert.equal((await node1.getDiagnostics()).enabled, false);

    const enabled = await node1.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(store1.get().keepAlive24x7Enabled, true);
    assert.ok(store1.get().keepAliveNodeId);

    const raw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    assert.equal(raw.keepAlive24x7Enabled, true);
    assert.ok(raw.keepAliveNodeId);

    node1.destroy();

    const store2 = new ClientStore(dir);
    await store2.load();
    assert.equal(store2.get().keepAlive24x7Enabled, true);

    const node2 = new KeepAliveNodeService(dir, store2);
    await node2.initialize();
    assert.equal((await node2.getDiagnostics()).enabled, true);
    assert.equal(node2.getNodeId(), store2.get().keepAliveNodeId);

    await node2.setEnabled(false);
    node2.destroy();

    const store3 = new ClientStore(dir);
    await store3.load();
    assert.equal(store3.get().keepAlive24x7Enabled, false);
  });
});

test("SQLite path is under userData/keepalive and uses WAL", async () => {
  await withTempDir(async (dir) => {
    const sqlite = new KeepAliveSqliteStore(dir);
    await sqlite.open();
    assert.equal(sqlite.dbPath, path.join(dir, "keepalive", "keepalive.sqlite"));
    assert.equal(sqlite.getMeta("schema_version"), "2");
    sqlite.close();
  });
});

test("Keep Alive initializes without Browser Profile infrastructure", async () => {
  await withTempDir(async (dir) => {
    const settings = new ClientStore(dir);
    await settings.load();
    const node = new KeepAliveNodeService(dir, settings);

    await node.initialize();
    const diag = await node.getDiagnostics();
    assert.equal(diag.storageReady, true);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.claimRuntimeEnabled, false);
    assert.equal(diag.phase, "durable-ack");
    assert.equal(diag.serverDurableAck, false);
    assert.ok(
      diag.snapshotSyncStatus === "not_started" ||
        diag.snapshotSyncStatus === "idle" ||
        diag.snapshotSyncStatus === "synced" ||
        diag.snapshotSyncStatus === "partial" ||
        diag.snapshotSyncStatus === "error" ||
        diag.snapshotSyncStatus === "syncing"
    );
    assert.ok(diag.dbPath?.includes("keepalive.sqlite"));

    node.destroy();
  });
});

test("wiring contract: Keep Alive IPC and UI present; claim remains opt-in", async () => {
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const contracts = await readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");
  const shell = await readFile(
    new URL("../src/renderer/components/app-shell.tsx", import.meta.url),
    "utf8"
  );
  const panel = await readFile(
    new URL("../src/renderer/components/keepalive-diagnostics-panel.tsx", import.meta.url),
    "utf8"
  );
  const store = await readFile(new URL("../src/main/storage/store.ts", import.meta.url), "utf8");

  assert.match(main, /KeepAliveNodeService/);
  assert.match(main, /keepAliveNode\.initialize/);
  assert.match(main, /getKeepAliveDiagnostics/);
  assert.match(main, /setKeepAliveEnabled/);
  assert.match(main, /RPA_CAMPAIGN_CLAIM/);
  assert.match(contracts, /getKeepAliveDiagnostics/);
  assert.match(contracts, /assignedCampaignCount/);
  assert.match(contracts, /detectedGapCount/);
  assert.match(store, /keepAlive24x7Enabled/);
  assert.match(shell, /KeepAliveDiagnosticsPanel/);
  assert.match(panel, /Keep Alive 24\/7/);
  assert.match(panel, /Registration/);
  assert.match(panel, /Snapshot sync/);
  assert.match(panel, /Pending recovery/);
  assert.match(panel, /Storage health/);
  assert.doesNotMatch(panel, /claimCampaign|ackCampaign/i);
  assert.match(panel, /server ACK/i);
  assert.match(panel, /Local applied sequence|Server ACK sequence/i);
});
