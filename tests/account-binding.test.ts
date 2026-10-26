import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfileManager } from "../src/main/browser/profile-manager.js";

test("AccountBinding: bind, switch, and unbind account lifecycle", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-binding-test-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const p = await pm.create("Facebook Profile 01", "facebook");
    assert.equal(p.accountBinding?.accountId, null);
    assert.equal(p.executionConfirmation?.status, "not_run");

    // 1. Bind Account A
    const boundA = await pm.bindAccount(p.browserId, "acc_uuid_111", "FB Account 1");
    assert.equal(boundA.accountBinding?.accountId, "acc_uuid_111");
    assert.equal(boundA.accountBinding?.accountName, "FB Account 1");
    assert.ok(boundA.accountBinding?.boundAt);
    assert.equal(boundA.executionConfirmation?.status, "not_run");

    // Simulate execution confirmation being confirmed on Account A
    boundA.executionConfirmation = {
      status: "confirmed",
      firstRunAt: "2026-10-26T12:00:00Z",
      lastSuccessAt: "2026-10-26T12:05:00Z",
      lastRunId: "run_999",
      screenshotRef: "screenshots/run_999.png",
    };

    // 2. Rename profile does NOT reset confirmation
    const renamed = await pm.rename(p.browserId, "Facebook Profile 01 Renamed");
    assert.equal(renamed.accountBinding?.accountId, "acc_uuid_111");
    assert.equal(renamed.executionConfirmation?.status, "confirmed");
    assert.equal(renamed.executionConfirmation?.lastRunId, "run_999");

    // 3. Switch Account A -> Account B resets confirmation
    const boundB = await pm.bindAccount(p.browserId, "acc_uuid_222", "FB Account 2");
    assert.equal(boundB.accountBinding?.accountId, "acc_uuid_222");
    assert.equal(boundB.accountBinding?.accountName, "FB Account 2");
    assert.equal(boundB.executionConfirmation?.status, "not_run");
    assert.equal(boundB.executionConfirmation?.lastRunId, null);
    assert.equal(boundB.executionConfirmation?.screenshotRef, null);

    // 4. Unbind Account
    const unbound = await pm.unbindAccount(p.browserId);
    assert.equal(unbound.accountBinding?.accountId, null);
    assert.equal(unbound.executionConfirmation?.status, "not_run");

    // 5. Verify persistence across re-initialization
    const pm2 = new ProfileManager(tmpDir);
    await pm2.initialize();
    const loaded = pm2.get(p.browserId);
    assert.ok(loaded);
    assert.equal(loaded?.name, "Facebook Profile 01 Renamed");
    assert.equal(loaded?.accountBinding?.accountId, null);
    assert.equal(loaded?.executionConfirmation?.status, "not_run");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
