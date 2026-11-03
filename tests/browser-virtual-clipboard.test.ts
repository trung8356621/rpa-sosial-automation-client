import assert from "node:assert/strict";
import test from "node:test";

import { BrowserVirtualClipboard } from "../src/main/browser/browser-virtual-clipboard.js";
import {
  buildClipboardPagePatchScript,
  isIsolatedClipboardShortcut,
} from "../src/main/browser/browser-clipboard-helpers.js";

test("virtual clipboard isolates text between browser profiles", () => {
  const store = new BrowserVirtualClipboard();
  store.write("browser-a", "SYNTHETIC_CLIP_A_9f3c");
  store.write("browser-b", "SYNTHETIC_CLIP_B_2d1e");

  assert.equal(store.read("browser-a"), "SYNTHETIC_CLIP_A_9f3c");
  assert.equal(store.read("browser-b"), "SYNTHETIC_CLIP_B_2d1e");
  assert.notEqual(store.read("browser-a"), store.read("browser-b"));
});

test("clearing one browser does not wipe another", () => {
  const store = new BrowserVirtualClipboard();
  store.write("browser-a", "keep-me");
  store.write("browser-b", "drop-me");
  store.clear("browser-b");

  assert.equal(store.read("browser-a"), "keep-me");
  assert.equal(store.read("browser-b"), "");
  assert.equal(store.has("browser-b"), false);
});

test("clipboard shortcut detector only matches Ctrl/Cmd C V X without Shift/Alt", () => {
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyDown",
      key: "c",
      control: true,
      meta: false,
      alt: false,
      shift: false,
    }),
    "copy"
  );
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyDown",
      key: "v",
      control: true,
      meta: false,
      alt: false,
      shift: false,
    }),
    "paste"
  );
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyDown",
      key: "x",
      control: false,
      meta: true,
      alt: false,
      shift: false,
    }),
    "cut"
  );
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyDown",
      key: "c",
      control: true,
      meta: false,
      alt: false,
      shift: true,
    }),
    null
  );
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyDown",
      key: "a",
      control: true,
      meta: false,
      alt: false,
      shift: false,
    }),
    null
  );
  assert.equal(
    isIsolatedClipboardShortcut({
      type: "keyUp",
      key: "c",
      control: true,
      meta: false,
      alt: false,
      shift: false,
    }),
    null
  );
});

test("page patch script redirects clipboard APIs and never mentions electron.clipboard", () => {
  const script = buildClipboardPagePatchScript();
  assert.match(script, /__rpaIsolatedClipboard/);
  assert.match(script, /navigator\.clipboard/);
  assert.match(script, /execCommand/);
  assert.doesNotMatch(script, /electron\.clipboard|require\(/);
  assert.doesNotMatch(script, /from ["']electron["']/);
});
