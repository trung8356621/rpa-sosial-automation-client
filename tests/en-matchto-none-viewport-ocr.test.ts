import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { resolveVisualTarget, OcrNotFound, TargetNotConfident } from "../src/main/orc/target-resolver.js";
import type { OcrEngine } from "../src/main/orc/ocr.js";
import type { Payload } from "../src/main/orc/contracts.js";

async function makeTestImages() {
  // 1024x560 white frame with a gray banner at y=150..250 and a dark-bordered box at y=329..370
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 507, height: 41, channels: 3, background: { r: 230, g: 245, b: 230 } },
        })
          .png()
          .toBuffer(),
        left: 181,
        top: 180,
      },
      {
        input: await sharp({
          create: { width: 507, height: 41, channels: 3, background: { r: 240, g: 240, b: 240 } },
        })
          .png()
          .toBuffer(),
        left: 181,
        top: 329,
      },
    ])
    .png()
    .toBuffer();

  // 507x41 template with high contrast edge so matchTemplate detail check (>=25) passes
  const template = await sharp({
    create: { width: 507, height: 41, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 507, height: 2, channels: 3, background: { r: 100, g: 100, b: 100 } },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  return { frame, template };
}

function makeEnTitlePayload(): Payload {
  return {
    action: "CLICK_AND_TYPE",
    target: {
      asset: "assets/en-title.png",
      roi: { x: 181, y: 180, width: 507, height: 41 },
      matchTo: "none",
      ocr: {
        kind: "line",
        text: "Add title",
        bbox: { x: 11, y: 11, width: 83, height: 18 },
        confidence: 95,
        confirmed: true,
        language: "vie+eng",
      },
    },
  };
}

test("matchTo=none with confirmed OCR falls back to full-viewport OCR when target shifted >64px within viewport", async () => {
  const { frame, template } = await makeTestImages();
  const ocrCalls: Array<{ width?: number; height?: number }> = [];
  const fakeOcr: OcrEngine = {
    async recognize(image) {
      const meta = await sharp(image).metadata();
      ocrCalls.push({ width: meta.width, height: meta.height });
      // Cropped local ROI (635x169) only sees notice text, not "Add title" at y=340
      if ((meta.height ?? 0) < 300) {
        return {
          text: "Plugin notice",
          confidence: 92,
          language: "vie+eng",
          segments: [
            {
              id: "notice-1",
              kind: "line",
              text: "Plugin notice",
              confidence: 92,
              bbox: { x: 80, y: 70, width: 120, height: 18 },
            },
          ],
        };
      }
      // Full viewport (1024x560) sees "Add title" shifted down to y=340
      return {
        text: "Plugin notice\nAdd title",
        confidence: 96,
        language: "vie+eng",
        segments: [
          {
            id: "notice-1",
            kind: "line",
            text: "Plugin notice",
            confidence: 92,
            bbox: { x: 197, y: 186, width: 120, height: 18 },
          },
          {
            id: "title-1",
            kind: "line",
            text: "Add title",
            confidence: 96,
            bbox: { x: 192, y: 340, width: 83, height: 18 },
          },
        ],
      };
    },
  };

  const resolved = await resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr);
  assert.equal(resolved.method, "ocr");
  assert.ok(Math.abs(resolved.x - (192 + 83 / 2)) <= 1);
  assert.ok(Math.abs(resolved.y - (340 + 18 / 2)) <= 1);
  assert.ok(ocrCalls.length >= 2);
  assert.ok((ocrCalls[0].height ?? 0) < 300);
  assert.equal(ocrCalls[1].width, 1024);
  assert.equal(ocrCalls[1].height, 560);
});

test("matchTo=none still throws OcrNotFound when target is absent from full viewport", async () => {
  const { frame, template } = await makeTestImages();
  const fakeOcr: OcrEngine = {
    async recognize() {
      return {
        text: "Thêm tiêu đề",
        confidence: 95,
        language: "vie+eng",
        segments: [
          {
            id: "vi-title",
            kind: "line",
            text: "Thêm tiêu đề",
            confidence: 95,
            bbox: { x: 192, y: 340, width: 110, height: 18 },
          },
        ],
      };
    },
  };

  await assert.rejects(
    () => resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr),
    (err: unknown) => err instanceof TargetNotConfident && (err instanceof OcrNotFound || err.resolution?.ocrOutcome === "NOT_FOUND"),
  );
});

async function makeFocusedBoxImages(duplicateBox = false) {
  const template = await sharp({
    create: { width: 507, height: 41, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 507, height: 2, channels: 3, background: { r: 140, g: 140, b: 140 } },
        }).png().toBuffer(),
        left: 0, top: 0,
      },
      {
        input: await sharp({
          create: { width: 507, height: 2, channels: 3, background: { r: 140, g: 140, b: 140 } },
        }).png().toBuffer(),
        left: 0, top: 39,
      },
      {
        input: await sharp({
          create: { width: 2, height: 41, channels: 3, background: { r: 140, g: 140, b: 140 } },
        }).png().toBuffer(),
        left: 0, top: 0,
      },
      {
        input: await sharp({
          create: { width: 83, height: 14, channels: 3, background: { r: 120, g: 120, b: 120 } },
        }).png().toBuffer(),
        left: 11, top: 13,
      },
    ])
    .png()
    .toBuffer();

  const boxParts = async (topY: number) => [
    {
      input: await sharp({
        create: { width: 507, height: 3, channels: 3, background: { r: 0, g: 90, b: 135 } },
      }).png().toBuffer(),
      left: 181, top: topY,
    },
    {
      input: await sharp({
        create: { width: 507, height: 3, channels: 3, background: { r: 0, g: 90, b: 135 } },
      }).png().toBuffer(),
      left: 181, top: topY + 38,
    },
    {
      input: await sharp({
        create: { width: 3, height: 41, channels: 3, background: { r: 0, g: 90, b: 135 } },
      }).png().toBuffer(),
      left: 181, top: topY,
    },
    {
      input: await sharp({
        create: { width: 83, height: 14, channels: 3, background: { r: 120, g: 120, b: 120 } },
      }).png().toBuffer(),
      left: 192, top: topY + 13,
    },
  ];

  const overlays = [...(await boxParts(329))];
  if (duplicateBox) {
    overlays.push(...(await boxParts(420)));
  }
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(overlays)
    .png()
    .toBuffer();

  return { frame, template };
}

test("focused input box recovers via inset OCR when full-viewport OCR returns no candidates", async () => {
  const { frame, template } = await makeFocusedBoxImages();

  const ocrCalls: Array<{ width?: number; height?: number }> = [];
  const fakeOcr: OcrEngine = {
    async recognize(image) {
      const meta = await sharp(image).metadata();
      ocrCalls.push({ width: meta.width, height: meta.height });
      // Inset crop (width=497, height=31) strips the focus border and reads "Add title".
      if ((meta.height ?? 0) <= 35 && (meta.width ?? 0) <= 500) {
        return {
          text: "Add title",
          confidence: 90,
          language: "vie+eng",
          segments: [
            {
              id: "title-inset",
              kind: "line",
              text: "Add title",
              confidence: 90,
              bbox: { x: 6, y: 6, width: 83, height: 18 },
            },
          ],
        };
      }
      // Full-viewport and local-ROI OCR miss the focused input text.
      return { text: "Add Post", confidence: 96, language: "vie+eng", segments: [] };
    },
  };

  const resolved = await resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr);
  assert.equal(resolved.method, "ocr");
  assert.equal(resolved.resolution.fallbackReason, "FOCUSED_BOX_INSET_OCR");
  assert.ok(Math.abs(resolved.x - (181 + 5 + 6 + 83 / 2)) <= 1);
  assert.ok(Math.abs(resolved.y - (329 + 5 + 6 + 18 / 2)) <= 1);
  assert.ok(ocrCalls.some((c) => (c.height ?? 0) <= 35 && (c.width ?? 0) <= 500));
});

test("inset OCR proposal >= 0.85 never authorizes a click when OCR text mismatches or is low confidence", async () => {
  const { frame, template } = await makeFocusedBoxImages();
  for (const insetSegment of [
    { id: "vi", kind: "line" as const, text: "Thêm tiêu đề", confidence: 95, bbox: { x: 6, y: 6, width: 110, height: 18 } },
    { id: "low", kind: "line" as const, text: "Add title", confidence: 79, bbox: { x: 6, y: 6, width: 83, height: 18 } },
  ]) {
    const fakeOcr: OcrEngine = {
      async recognize(image) {
        const meta = await sharp(image).metadata();
        if ((meta.height ?? 0) <= 35 && (meta.width ?? 0) <= 500) {
          return { text: insetSegment.text, confidence: insetSegment.confidence, language: "vie+eng", segments: [insetSegment] };
        }
        return { text: "", confidence: 0, language: "vie+eng", segments: [] };
      },
    };
    await assert.rejects(
      () => resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr),
      (err: unknown) => err instanceof OcrNotFound && err.outcome === "NOT_FOUND",
    );
  }
});

test("ambiguous template match never triggers inset OCR or authorizes a click", async () => {
  const { frame, template } = await makeFocusedBoxImages(true);
  let insetOcrCalled = false;
  const fakeOcr: OcrEngine = {
    async recognize(image) {
      const meta = await sharp(image).metadata();
      if ((meta.height ?? 0) <= 35 && (meta.width ?? 0) <= 500) {
        insetOcrCalled = true;
      }
      return { text: "", confidence: 0, language: "vie+eng", segments: [] };
    },
  };
  await assert.rejects(
    () => resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr),
    (err: unknown) => err instanceof OcrNotFound && err.outcome === "NOT_FOUND",
  );
  assert.equal(insetOcrCalled, false);
});

test("multiple matching OCR lines inside inset crop reject with NOT_FOUND", async () => {
  const { frame, template } = await makeFocusedBoxImages();
  const fakeOcr: OcrEngine = {
    async recognize(image) {
      const meta = await sharp(image).metadata();
      if ((meta.height ?? 0) <= 35 && (meta.width ?? 0) <= 500) {
        return {
          text: "Add title\nAdd title",
          confidence: 95,
          language: "vie+eng",
          segments: [
            { id: "t1", kind: "line", text: "Add title", confidence: 95, bbox: { x: 6, y: 2, width: 83, height: 12 } },
            { id: "t2", kind: "line", text: "Add title", confidence: 94, bbox: { x: 6, y: 16, width: 83, height: 12 } },
          ],
        };
      }
      return { text: "", confidence: 0, language: "vie+eng", segments: [] };
    },
  };
  await assert.rejects(
    () => resolveVisualTarget(frame, template, makeEnTitlePayload(), fakeOcr),
    (err: unknown) => err instanceof OcrNotFound && err.outcome === "NOT_FOUND",
  );
});
