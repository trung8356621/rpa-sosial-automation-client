import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceManager } from "../src/main/device/device-manager.js";

test("DeviceManager: generates and persists durable UUID device_id", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-device-test-"));
  try {
    const manager1 = new DeviceManager(tmpDir);
    const info1 = await manager1.initialize();

    assert.ok(info1.deviceId.startsWith("dev_"), "deviceId must have dev_ prefix");
    assert.ok(info1.deviceId.length > 20, "deviceId must be UUID format");
    assert.strictEqual(info1.clientVersion, "0.1.0");
    assert.ok(["windows", "linux", "macos", "other"].includes(info1.osFamily));
    assert.ok(typeof info1.osLabel === "string" && info1.osLabel.length > 0);

    // Second initialization with same userData path must yield identical deviceId
    const manager2 = new DeviceManager(tmpDir);
    const info2 = await manager2.initialize();

    assert.strictEqual(info2.deviceId, info1.deviceId, "Device ID must persist across restarts");

    // Display name update
    await manager2.setDisplayName("Office Workstation #1");
    const info3 = manager2.getDeviceInfo();
    assert.strictEqual(info3.displayName, "Office Workstation #1");

    // Check persistence of display name
    const manager3 = new DeviceManager(tmpDir);
    const info4 = await manager3.initialize();
    assert.strictEqual(info4.displayName, "Office Workstation #1");
    assert.strictEqual(info4.deviceId, info1.deviceId);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
