import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfileManager } from "../src/main/browser/profile-manager.js";

test("ProfileManager: creates profile with durable UUID and immutable partition", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-profile-test-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const p1 = await pm.create("Facebook Marketing 01", "facebook", { accountId: "acc-1", boundAt: new Date().toISOString() });
    assert.ok(p1.browserId);
    assert.equal(p1.accountBinding?.accountName || p1.name, "Facebook Marketing 01");
    assert.equal(p1.platform, "facebook");
    assert.equal(p1.partition, `persist:rpa-client-${p1.browserId}`);
    assert.equal(p1.status, "stopped");

    // Persistence reload
    const pm2 = new ProfileManager(tmpDir);
    await pm2.initialize();
    const loaded = pm2.get(p1.browserId);
    assert.ok(loaded);
    assert.equal(loaded?.accountBinding?.accountName || loaded?.name, "Facebook Marketing 01");
    assert.equal(loaded?.partition, `persist:rpa-client-${p1.browserId}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ProfileManager: single running browser enforcement", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-profile-test-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const p1 = await pm.create("Profile 1", "facebook", { accountId: "acc-1", boundAt: new Date().toISOString() });
    const p2 = await pm.create("Profile 2", "facebook", { accountId: "acc-2", boundAt: new Date().toISOString() });

    await pm.setStatus(p1.browserId, "running");
    assert.equal(pm.getActiveId(), p1.browserId);
    assert.equal(pm.get(p1.browserId)?.status, "running");

    // Starting p2 automatically sets p1 to stopped
    await pm.setStatus(p2.browserId, "running");
    assert.equal(pm.getActiveId(), p2.browserId);
    assert.equal(pm.get(p2.browserId)?.status, "running");
    assert.equal(pm.get(p1.browserId)?.status, "stopped");

    // Stopping p2
    await pm.setStatus(p2.browserId, "stopped");
    assert.equal(pm.getActiveId(), null);
    assert.equal(pm.get(p2.browserId)?.status, "stopped");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ProfileManager: deletion safety", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-profile-test-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const p1 = await pm.create("Profile To Delete", "facebook", { accountId: "acc-delete", boundAt: new Date().toISOString() });
    await pm.setStatus(p1.browserId, "running");

    // Cannot delete active running profile
    await assert.rejects(
      async () => await pm.delete(p1.browserId),
      /Không thể xóa Browser Profile đang chạy/
    );

    // Can delete once stopped
    await pm.setStatus(p1.browserId, "stopped");
    const ok = await pm.delete(p1.browserId);
    assert.equal(ok, true);
    assert.equal(pm.get(p1.browserId), undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
