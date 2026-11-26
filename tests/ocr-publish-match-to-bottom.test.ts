import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { LocalOcr } from "../src/main/orc/ocr.js";
import { findChromaticButtonChips } from "../src/main/orc/ocr-button-chips.js";
import { findOcrCandidates } from "../src/main/orc/ocr-candidates.js";
import { resolveVisualTarget, OcrNotFound } from "../src/main/orc/target-resolver.js";
import type { Payload } from "../src/main/orc/contracts.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = [
  path.join(root, "fixtures/ocr-publish-match-to-bottom-d99eb08f.png"),
  path.join(root, "fixtures/ocr-publish-match-to-bottom-3a5d289a.png"),
];

const publishSelection = {
  text: "Publish",
  kind: "line" as const,
  bbox: { x: 14, y: 18, width: 46, height: 11 },
  confidence: 92,
  confirmed: true as const,
  language: "vie+eng" as const,
};

const modalSearchRegion = { x: 200, y: 40, width: 580, height: 480 };

function payloadFor(matchTo: "bottom" | "none" = "bottom"): Payload {
  return {
    action: "CLICK_TARGET",
    target: {
      asset: "publish.png",
      roi: { x: 688, y: 489, width: 75, height: 39 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo,
      ocr: publishSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
}

test("real captures: chromatic chip hugs visible Publish button", async () => {
  for (const file of fixtures) {
    const frame = readFileSync(file);
    const meta = await sharp(frame).metadata();
    assert.equal(meta.width, 1024);
    assert.equal(meta.height, 560);
    const chips = await findChromaticButtonChips(frame);
    assert.ok(chips.length >= 1, file);
    const chip = chips.find((c) => c.y + c.height / 2 > 450);
    assert.ok(chip, `Publish chip near bottom in ${file}`);
    assert.ok(chip!.width >= 48 && chip!.width <= 120);
    assert.ok(chip!.height >= 18 && chip!.height <= 55);
  }
});

test("real captures: full-viewport LocalOcr recognizes visible Publish", async () => {
  const ocr = new LocalOcr();
  try {
    for (const file of fixtures) {
      const frame = readFileSync(file);
      const result = await ocr.recognize(frame);
      const hits = findOcrCandidates(result, publishSelection);
      assert.equal(hits.length, 1, file);
      assert.ok(hits[0]!.confidence >= 80);
      assert.match(hits[0]!.text, /Publish/i);
      const cx = hits[0]!.bbox.x + hits[0]!.bbox.width / 2;
      const cy = hits[0]!.bbox.y + hits[0]!.bbox.height / 2;
      // BrowserCore 1024×560 viewport coordinates.
      assert.ok(cx >= 688 && cx <= 762, `x=${cx}`);
      assert.ok(cy >= 489 && cy <= 527, `y=${cy}`);
      assert.ok(
        cx >= modalSearchRegion.x &&
          cx <= modalSearchRegion.x + modalSearchRegion.width &&
          cy >= modalSearchRegion.y &&
          cy <= modalSearchRegion.y + modalSearchRegion.height,
        "Publish center stays inside modal searchRegion",
      );
    }
  } finally {
    await ocr.close();
  }
});

test("Match To Bottom resolves Publish on real bottom-scrolled captures", async () => {
  const ocr = new LocalOcr();
  try {
    const template = await sharp({
      create: { width: 74, height: 43, channels: 3, background: "#2657d9" },
    })
      .png()
      .toBuffer();
    for (const file of fixtures) {
      const frame = readFileSync(file);
      const resolved = await resolveVisualTarget(
        frame,
        template,
        payloadFor("bottom"),
        ocr,
        modalSearchRegion,
      );
      assert.equal(resolved.method, "ocr");
      assert.ok(resolved.x >= 688 && resolved.x <= 762);
      assert.ok(resolved.y >= 489 && resolved.y <= 527);
      assert.ok((resolved.confidence ?? 0) >= 80);
    }
  } finally {
    await ocr.close();
  }
});

test("missing OCR target remains blocked (no false click)", async () => {
  const ocr = new LocalOcr();
  try {
    const frame = readFileSync(fixtures[0]!);
    const template = await sharp({
      create: { width: 74, height: 43, channels: 3, background: "#2657d9" },
    })
      .png()
      .toBuffer();
    const payload: Payload = {
      action: "CLICK_TARGET",
      target: {
        asset: "missing.png",
        roi: { x: 688, y: 489, width: 75, height: 39 },
        environment: { width: 1024, height: 560, zoom: 1 },
        matchTo: "bottom",
        ocr: {
          ...publishSelection,
          text: "DefinitelyNotOnScreenXYZ",
        },
        clickOffset: { x: 0, y: 0 },
      },
    };
    await assert.rejects(
      () => resolveVisualTarget(frame, template, payload, ocr, modalSearchRegion),
      (error: unknown) => error instanceof OcrNotFound,
    );
  } finally {
    await ocr.close();
  }
});

test("image-only Match To None still resolves without OCR selection", async () => {
  const chip = await sharp({
    create: { width: 120, height: 40, channels: 3, background: "#111111" },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 120, height: 2, channels: 3, background: "#eeeeee" },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#ffffff" },
  })
    .composite([{ input: chip, left: 400, top: 200 }])
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "image-only.png",
      roi: { x: 400, y: 200, width: 120, height: 40 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "none",
      clickOffset: { x: 0, y: 0 },
    },
  };
  const resolved = await resolveVisualTarget(
    frame,
    chip,
    payload,
    { recognize: async () => ({ text: "", confidence: 0, segments: [], language: "vie+eng" }) },
  );
  assert.equal(resolved.method, "image");
  assert.ok(resolved.x >= 400 && resolved.x <= 520);
  assert.ok(resolved.y >= 200 && resolved.y <= 240);
});

test("VisualOrcExecutor distinguishes destination OCR miss from SCROLL_LIMIT", () => {
  const executorPath = path.join(root, "../src/main/orc/visual-executor.ts");
  const source = readFileSync(executorPath, "utf8");
  assert.match(source, /OCR_TARGET_MISSING_AT_DESTINATION/);
  assert.match(source, /SCROLL_LIMIT/);
  assert.match(source, /DESTINATION_REACHED/);
  // Job fallback stays keyed on NOT_FOUND + confirmedNotFound.
  assert.match(source, /confirmedNotFound \? "NOT_FOUND"/);
  assert.match(source, /advanceOcrSearch/);
});

test("LocalOcr wires chromatic button chip pass", () => {
  const ocrPath = path.join(root, "../src/main/orc/ocr.ts");
  const source = readFileSync(ocrPath, "utf8");
  assert.match(source, /findChromaticButtonChips/);
  assert.match(source, /chipAlreadyCovered/);
  assert.match(source, /readRegionOnce/);
});
