import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("interaction lock uses native overlay WebContentsView (not React z-index)", async () => {
  const src = await readFile(
    path.join(root, "src/main/browser/browser-interaction-lock.ts"),
    "utf8"
  );
  assert.match(src, /WebContentsView/);
  assert.match(src, /addChildView/);
  assert.match(src, /Dừng automation/);
  assert.match(src, /unlockForHuman/);
  assert.match(src, /relockAfterHuman/);
  assert.doesNotMatch(src, /z-index/);
});

test("embedded browser wires lock around Auth and releases on end/stop", async () => {
  const src = await readFile(path.join(root, "src/main/browser/embedded-browser.ts"), "utf8");
  assert.match(src, /interactionLock\.lock/);
  assert.match(src, /interactionLock\.release/);
  assert.match(src, /AUTH_CANCELLED|stopAutomation/);
  assert.match(src, /resolveTagFromAccountContext|authContextFinder/);
  assert.match(src, /HUMAN_REQUIRED/);
});

test("contracts expose stopAutomation / resumeAutomationAfterHuman", async () => {
  const src = await readFile(path.join(root, "src/shared/contracts.ts"), "utf8");
  assert.match(src, /stopAutomation/);
  assert.match(src, /resumeAutomationAfterHuman/);
  assert.match(src, /automationLock/);
});
