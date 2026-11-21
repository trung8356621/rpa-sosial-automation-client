import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { resolveAppIconPath } from "../src/main/app/app-icon";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(projectRoot, "assets");

test("generated RPA automation icon assets exist with expected dimensions and ICO frames", async () => {
  const mainPngPath = path.join(assetsDir, "rpa-automation-icon.png");
  const png256Path = path.join(assetsDir, "rpa-automation-icon-256.png");
  const png512Path = path.join(assetsDir, "rpa-automation-icon-512.png");
  const icoPath = path.join(assetsDir, "rpa-automation-icon.ico");

  for (const filePath of [mainPngPath, png256Path, png512Path, icoPath]) {
    assert.equal(fs.existsSync(filePath), true, `Missing icon asset: ${filePath}`);
    assert.ok(fs.statSync(filePath).size > 0, `Empty icon asset: ${filePath}`);
  }

  const meta256 = await sharp(png256Path).metadata();
  assert.equal(meta256.width, 256);
  assert.equal(meta256.height, 256);

  const meta512 = await sharp(png512Path).metadata();
  assert.equal(meta512.width, 512);
  assert.equal(meta512.height, 512);

  const icoBuffer = fs.readFileSync(icoPath);
  assert.equal(icoBuffer.readUInt16LE(0), 0);
  assert.equal(icoBuffer.readUInt16LE(2), 1);
  assert.equal(icoBuffer.readUInt16LE(4), 7);
});

test("resolveAppIconPath returns platform-appropriate icon asset", () => {
  assert.equal(
    resolveAppIconPath(projectRoot, "win32"),
    path.join(assetsDir, "rpa-automation-icon.ico"),
  );
  assert.equal(
    resolveAppIconPath(projectRoot, "linux"),
    path.join(assetsDir, "rpa-automation-icon-512.png"),
  );
  assert.equal(
    resolveAppIconPath(projectRoot, "darwin"),
    path.join(assetsDir, "rpa-automation-icon-512.png"),
  );
});

test("package.json preserves productName and configures rpa-automation-icon.ico", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ) as {
    productName?: string;
    build?: {
      productName?: string;
      win?: { icon?: string };
      mac?: { icon?: string };
      linux?: { icon?: string };
    };
  };

  assert.equal(pkg.productName, "RPA Execution Client V2");
  assert.equal(pkg.build?.win?.icon, "assets/rpa-automation-icon.ico");
  assert.equal(pkg.build?.mac?.icon, "assets/rpa-automation-icon-512.png");
  assert.equal(pkg.build?.linux?.icon, "assets/rpa-automation-icon-512.png");
});
