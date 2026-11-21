import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const projectRoot = process.cwd();
const srcArg = process.argv[2];
const assetsDir = path.join(projectRoot, "assets");
mkdirSync(assetsDir, { recursive: true });

const masterPngPath = path.join(assetsDir, "rpa-automation-icon.png");
if (srcArg) {
  await sharp(srcArg).png().toFile(masterPngPath);
}

const masterBuf = readFileSync(masterPngPath);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = await Promise.all(
  sizes.map((s) =>
    sharp(masterBuf)
      .resize(s, s, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer()
  )
);

await sharp(masterBuf).resize(256, 256).png().toFile(path.join(assetsDir, "rpa-automation-icon-256.png"));
await sharp(masterBuf).resize(512, 512).png().toFile(path.join(assetsDir, "rpa-automation-icon-512.png"));

// Build multi-resolution Windows ICO (PNG-compressed entries)
const count = sizes.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // ICON
header.writeUInt16LE(count, 4);

const dirEntries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
for (let i = 0; i < count; i++) {
  const s = sizes[i];
  const buf = pngBuffers[i];
  const off = i * 16;
  dirEntries.writeUInt8(s === 256 ? 0 : s, off + 0);
  dirEntries.writeUInt8(s === 256 ? 0 : s, off + 1);
  dirEntries.writeUInt8(0, off + 2);
  dirEntries.writeUInt8(0, off + 3);
  dirEntries.writeUInt16LE(1, off + 4);
  dirEntries.writeUInt16LE(32, off + 6);
  dirEntries.writeUInt32LE(buf.length, off + 8);
  dirEntries.writeUInt32LE(offset, off + 12);
  offset += buf.length;
}

const icoBuf = Buffer.concat([header, dirEntries, ...pngBuffers]);
writeFileSync(path.join(assetsDir, "rpa-automation-icon.ico"), icoBuf);
console.log("Generated icons in", assetsDir, "ICO bytes:", icoBuf.length);
