import test from "node:test";
import assert from "node:assert/strict";
import { detectOsMetadata } from "../src/shared/os-metadata.js";

test("detectOsMetadata: Windows 11 from build >= 22000", () => {
  const meta = detectOsMetadata({
    platform: "win32",
    release: "10.0.22631",
    type: "Windows_NT",
    arch: "x64",
  });
  assert.equal(meta.osFamily, "windows");
  assert.equal(meta.osLabel, "Windows 11");
  assert.equal(meta.platform, "windows");
});

test("detectOsMetadata: Windows 10 from build < 22000", () => {
  const meta = detectOsMetadata({
    platform: "win32",
    release: "10.0.19045",
    type: "Windows_NT",
    arch: "x64",
  });
  assert.equal(meta.osFamily, "windows");
  assert.equal(meta.osLabel, "Windows 10");
});

test("detectOsMetadata: Windows label prefers os.version() when explicit", () => {
  const meta = detectOsMetadata({
    platform: "win32",
    release: "10.0.99999",
    version: "Windows 10 Pro",
  });
  assert.equal(meta.osLabel, "Windows 10");
});

test("detectOsMetadata: Linux uses PRETTY_NAME / Ubuntu short form", () => {
  const meta = detectOsMetadata({
    platform: "linux",
    release: "6.8.0",
    linuxOsRelease: 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  });
  assert.equal(meta.osFamily, "linux");
  assert.equal(meta.osLabel, "Ubuntu 24.04");
});

test("detectOsMetadata: Linux fallback without os-release", () => {
  const meta = detectOsMetadata({ platform: "linux", release: "6.8.0" });
  assert.equal(meta.osLabel, "Linux");
});

test("detectOsMetadata: macOS with product version", () => {
  const meta = detectOsMetadata({
    platform: "darwin",
    release: "24.0.0",
    macosProductVersion: "15.1",
  });
  assert.equal(meta.osFamily, "macos");
  assert.equal(meta.osLabel, "macOS 15");
});

test("detectOsMetadata: macOS without product version does not guess", () => {
  const meta = detectOsMetadata({ platform: "darwin", release: "24.0.0" });
  assert.equal(meta.osLabel, "macOS");
});
