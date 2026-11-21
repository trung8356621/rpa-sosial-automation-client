import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_DEV_INSTANCES,
  acquireInstanceLock,
  parseDevInstanceId,
  resolveDevUserDataPath,
} from "../src/main/dev-instance.js";

test("parseDevInstanceId supports default null, CLI/env overrides, and rejects unknown ids", () => {
  assert.equal(parseDevInstanceId(["node", "main.js"], {}), null);
  assert.equal(parseDevInstanceId(["node", "main.js", "--instance=client-A"], {}), "client-A");
  assert.equal(parseDevInstanceId(["node", "main.js"], { RPA_DEV_INSTANCE: "client-B" }), "client-B");
  assert.equal(
    parseDevInstanceId(["node", "main.js", "--instance=client-C"], { RPA_DEV_INSTANCE: "client-A" }),
    "client-C"
  );
  assert.throws(() => parseDevInstanceId(["node", "main.js", "--instance=client-Z"], {}), /Invalid dev instance/);
});

test("resolveDevUserDataPath isolates 3 dev instances without touching default .local/client", () => {
  const root = "D:\\repo";
  assert.equal(resolveDevUserDataPath(root, null), path.join(root, ".local", "client"));
  const paths = ALLOWED_DEV_INSTANCES.map((id) => resolveDevUserDataPath(root, id));
  assert.equal(new Set(paths).size, 3);
  for (const p of paths) {
    assert.ok(!p.endsWith(path.join(".local", "client")));
    assert.ok(p.includes(path.join(".local", "instances")));
  }
});

test("acquireInstanceLock prevents simultaneous use of same userData and allows release/re-acquire", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpa-dev-lock-"));
  try {
    const lock1 = acquireInstanceLock(dir, process.pid);
    assert.throws(() => acquireInstanceLock(dir, process.pid), /already in use/);
    lock1.release();
    const lock2 = acquireInstanceLock(dir, process.pid);
    lock2.release();

    // Stale lockfile from dead PID is recovered automatically
    await writeFile(path.join(dir, "instance.lock"), JSON.stringify({ pid: 999999 }), "utf8");
    const lock3 = acquireInstanceLock(dir, process.pid);
    lock3.release();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
