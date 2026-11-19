import test from "node:test";
import assert from "node:assert/strict";
import { authStepToVisualPayload } from "../src/main/orc/step-to-payload.js";
import { effectiveMatchTo } from "../src/main/orc/match-to.js";
import { OrcAssetStore } from "../src/main/orc/asset-store.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("authStepToVisualPayload preserves Creator CLICK_TARGET schema", () => {
  const p = authStepToVisualPayload({
    id: "step-click",
    action: "CLICK_TARGET",
    method: "auto",
    threshold: 0.96,
    target: {
      asset: "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png",
      roi: { x: 166, y: 313, width: 684, height: 131 },
      matchTo: "top",
      environment: { width: 1024, height: 560, zoom: 1 },
      ocr: {
        confirmed: true,
        language: "vie+eng",
        kind: "line",
        text: "[redacted]",
        confidence: 88,
        bbox: { x: 16, y: 13, width: 168, height: 41 },
      },
    },
  });
  assert.ok(p);
  assert.equal(p!.action, "CLICK_TARGET");
  assert.equal(p!.target?.asset, "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png");
  assert.equal(p!.target?.matchTo, "top");
  assert.equal(p!.target?.ocr?.confirmed, true);
  assert.equal(effectiveMatchTo(p!), "top");
});

test("OrcAssetStore caches verified bytes and rejects sha mismatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orc-assets-"));
  try {
    const store = new OrcAssetStore(dir);
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const loaded = await store.ensureAssets({
      accountId: "a",
      packageKey: "pkg",
      version: "1",
      releaseId: 1,
      assets: [{ path: "roi.png", sha256: sha, kind: "roi" }],
      download: async () => ({
        status: 200,
        body: { asset_base64: bytes.toString("base64"), sha256: sha },
      }),
    });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.ok(loaded.byPath.get("roi.png")?.equals(bytes));
    }
    const bad = await store.ensureAssets({
      accountId: "a",
      packageKey: "pkg",
      version: "1",
      releaseId: 1,
      assets: [{ path: "other.png", sha256: "ab".repeat(32), kind: "roi" }],
      download: async () => ({
        status: 200,
        body: { asset_base64: bytes.toString("base64") },
      }),
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "ASSET_INTEGRITY_FAILED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
