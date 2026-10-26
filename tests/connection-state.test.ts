import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClientStore } from "../src/main/storage/store.js";

test("ClientStore: endpoint persistence and normalization", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-store-test-"));
  try {
    const store1 = new ClientStore(tmpDir);
    await store1.load();
    assert.strictEqual(store1.get().endpoint, "https://seo-ops.test");

    await store1.set({ endpoint: "https://custom-seo.ops.local" });
    assert.strictEqual(store1.get().endpoint, "https://custom-seo.ops.local");

    const store2 = new ClientStore(tmpDir);
    await store2.load();
    assert.strictEqual(store2.get().endpoint, "https://custom-seo.ops.local");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
