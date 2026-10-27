import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfileManager } from "../src/main/browser/profile-manager.js";

test("Account binding is immutable and unbinding requires deleting the Browser", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-binding-test-"));
  try {
    const pm = new ProfileManager(tmpDir); await pm.initialize();
    const created = await pm.createForAccount({accountId:"acc-a",platform:"facebook",displayName:"Account A",email:"a@example.com",username:null,identityLabel:null,verified:true});
    await assert.rejects(pm.bindAccount(created.profile.browserId,"acc-b"), /bất biến/);
    await assert.rejects(pm.unbindAccount(created.profile.browserId), /Không thể gỡ Account/);
    assert.equal(pm.get(created.profile.browserId)?.accountBinding?.accountId, "acc-a");
  } finally { await rm(tmpDir,{recursive:true,force:true}); }
});
