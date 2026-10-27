import assert from "node:assert/strict";
import test from "node:test";
import { ClipboardService } from "../src/main/clipboard/clipboard-service.js";

test("clipboard operations are serialized in click order even when password API is slow", async () => {
  let value = "old-password";
  const writes: string[] = [];
  const service = new ClipboardService({
    writeText(text) { value = text; writes.push(text); },
    readText() { return value; },
  });

  const slowPassword = service.copy(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "new-password";
  });
  const email = service.copy(() => "active@example.com");
  await Promise.all([slowPassword, email]);

  assert.deepEqual(writes, ["new-password", "active@example.com"]);
  assert.equal(value, "active@example.com");
});

test("failed resolution does not write stale clipboard content or block the next copy", async () => {
  let value = "existing";
  const service = new ClipboardService({
    writeText(text) { value = text; },
    readText() { return value; },
  });

  await assert.rejects(service.copy(async () => { throw new Error("API offline"); }), /API offline/);
  assert.equal(value, "existing");
  await service.copy(() => "next@example.com");
  assert.equal(value, "next@example.com");
});
