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

    const raw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    assert.equal(raw.keepAlive24x7Enabled, true);

    node1.destroy();

    const store2 = new ClientStore(dir);
    await store2.load();
    assert.equal(store2.get().keepAlive24x7Enabled, true);

    const node2 = new KeepAliveNodeService(dir, store2);
    await node2.initialize();
    assert.equal((await node2.getDiagnostics()).enabled, true);

    await node2.setEnabled(false);
    node2.destroy();

    const store3 = new ClientStore(dir);
    await store3.load();
    assert.equal(store3.get().keepAlive24x7Enabled, false);
  });
});

test("SQLite read/write: campaign, journal, checkpoint, screenshot metadata", async () => {
  await withTempDir(async (dir) => {
    const sqlite = new KeepAliveSqliteStore(dir);
    await sqlite.open();

    const snap = sqlite.upsertCampaignSnapshot("camp-1", { name: "Demo", version: 1 });
    assert.equal(snap.campaignId, "camp-1");
    const loaded = sqlite.getCampaignSnapshot("camp-1");
    assert.ok(loaded);
    assert.match(loaded.payloadJson, /Demo/);

    const inserted = sqlite.appendJournalEvent({
      eventId: "evt-1",
      jobId: "job-1",
      attemptId: "att-1",
      eventType: "started",
      payloadJson: JSON.stringify({ step: 1 }),
    });
    assert.equal(inserted, true);
    assert.equal(sqlite.getJournalEvent("evt-1")?.jobId, "job-1");

    sqlite.setSyncCheckpoint("cursor", { offset: 42 });
    assert.equal(sqlite.getSyncCheckpoint("cursor")?.valueJson.includes("42"), true);

    sqlite.upsertScreenshotMetadata({
      id: "shot-1",
      jobId: "job-1",
      filePath: "C:/tmp/final.png",
      metaJson: JSON.stringify({ width: 1280 }),
    });
    assert.equal(sqlite.getScreenshotMetadata("shot-1")?.filePath, "C:/tmp/final.png");

    sqlite.markLocalSyncComplete("2026-11-20T05:00:00.000Z");
    const stats = await sqlite.getStats();
    assert.equal(stats.campaignCount, 1);
    assert.equal(stats.jobCount, 1);
    assert.equal(stats.pendingSyncCount, 1);
    assert.equal(stats.lastSyncAt, "2026-11-20T05:00:00.000Z");
    assert.ok(stats.storageBytes > 0);

    sqlite.close();
  });
});

test("duplicate journal event_id is idempotent", async () => {
  await withTempDir(async (dir) => {
    const sqlite = new KeepAliveSqliteStore(dir);
    await sqlite.open();

    const first = sqlite.appendJournalEvent({
      eventId: "dup-1",
      jobId: "job-a",
      eventType: "completed",
      payloadJson: JSON.stringify({ n: 1 }),
    });
    const second = sqlite.appendJournalEvent({
      eventId: "dup-1",
      jobId: "job-b",
      eventType: "completed",
      payloadJson: JSON.stringify({ n: 2 }),
    });

    assert.equal(first, true);
    assert.equal(second, false);

    const row = sqlite.getJournalEvent("dup-1");
    assert.equal(row?.jobId, "job-a");
    assert.match(row?.payloadJson ?? "", /"n":1/);

    const stats = await sqlite.getStats();
    assert.equal(stats.jobCount, 1);
    assert.equal(stats.pendingSyncCount, 1);

    sqlite.close();
  });
});

test("restart recovery restores SQLite rows without Browser", async () => {
  await withTempDir(async (dir) => {
    const settings = new ClientStore(dir);
    await settings.load();

    const node1 = new KeepAliveNodeService(dir, settings);
    await node1.initialize();
    await node1.setEnabled(true);
    await node1.upsertCampaignSnapshot("camp-r", { title: "recover-me" });
    await node1.appendJournalEvent({
      eventId: "evt-r",
      jobId: "job-r",
      eventType: "checkpoint",
    });
    await node1.setSyncCheckpoint("phase", { step: "local" });
    await node1.upsertScreenshotMetadata({ id: "shot-r", jobId: "job-r" });
    await node1.markLocalSyncComplete("2026-11-20T06:00:00.000Z");
    node1.destroy();

    // Fresh process simulation — no EmbeddedBrowser / ProfileManager involved.
    const settings2 = new ClientStore(dir);
    await settings2.load();
    const node2 = new KeepAliveNodeService(dir, settings2);
    await node2.initialize();

    const diag = await node2.getDiagnostics();
    assert.equal(diag.enabled, true);
    assert.equal(diag.storageReady, true);
    assert.equal(diag.browserRequired, false);
    assert.equal(diag.campaignCount, 1);
    assert.equal(diag.jobCount, 1);
    assert.equal(diag.pendingSyncCount, 1);
    assert.equal(diag.lastSyncAt, "2026-11-20T06:00:00.000Z");
    assert.equal(diag.phase, "local-poc");

    assert.equal(node2.sqlite.getCampaignSnapshot("camp-r")?.campaignId, "camp-r");
    assert.equal(node2.sqlite.getJournalEvent("evt-r")?.eventType, "checkpoint");
    assert.ok(node2.sqlite.getSyncCheckpoint("phase"));
    assert.ok(node2.sqlite.getScreenshotMetadata("shot-r"));

    node2.destroy();
  });
});

test("Keep Alive initializes without Browser Profile infrastructure", async () => {
  await withTempDir(async (dir) => {
    const settings = new ClientStore(dir);
    await settings.load();
    const node = new KeepAliveNodeService(dir, settings);

    // Intentionally never construct ProfileManager / EmbeddedBrowser.
    await node.initialize();
    const diag = await node.getDiagnostics();
    assert.equal(diag.storageReady, true);
    assert.equal(diag.browserRequired, false);
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
  assert.match(contracts, /setKeepAliveEnabled/);
  assert.match(contracts, /KeepAliveDiagnostics/);
  assert.match(store, /keepAlive24x7Enabled/);
  assert.match(shell, /KeepAliveDiagnosticsPanel/);
  assert.match(panel, /Keep Alive 24\/7/);
  assert.match(panel, /setKeepAliveEnabled/);

  // Phase 1 must not invent Server claim/ACK from Keep Alive path.
  assert.doesNotMatch(panel, /claimCampaign|ackCampaign|fake.?sync/i);
  const keepaliveMainSlice = main.slice(
    main.indexOf("KeepAliveNodeService"),
    main.indexOf("KeepAliveNodeService") + 800
  );
  assert.doesNotMatch(keepaliveMainSlice, /claim\(|\.claim\b/);
});
