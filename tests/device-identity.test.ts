import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceManager } from "../src/main/device/device-manager.js";

test("DeviceManager: host metadata only — no Device UUID", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rpa-host-"));
  try {
    const dm1 = new DeviceManager(dir);
    const info1 = await dm1.initialize();
    assert.ok(info1.displayName);
    assert.ok(info1.osFamily);
    assert.ok(info1.clientVersion);
    assert.equal((info1 as { deviceId?: string }).deviceId, undefined);

    const dm2 = new DeviceManager(dir);
    const info2 = await dm2.initialize();
    assert.equal(info2.displayName, info1.displayName);

    await dm2.setDisplayName("Station A");
    const dm3 = new DeviceManager(dir);
    const info3 = await dm3.initialize();
    assert.equal(info3.displayName, "Station A");

    const raw = JSON.parse(await readFile(path.join(dir, "host-meta.json"), "utf8"));
    assert.equal(raw.deviceId, undefined);
    assert.equal(raw.displayName, "Station A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DeviceManager: migrates displayName from legacy device.json, ignores deviceId", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rpa-host-legacy-"));
  try {
    await writeFile(
      path.join(dir, "device.json"),
      JSON.stringify({ deviceId: "dev_should_be_ignored", displayName: "Legacy Host" }),
      "utf8"
    );
    const dm = new DeviceManager(dir);
    const info = await dm.initialize();
    assert.equal(info.displayName, "Legacy Host");
    assert.equal((info as { deviceId?: string }).deviceId, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
