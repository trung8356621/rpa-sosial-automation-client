import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { buildTransparentOverlayHtml } from "../src/main/browser/execution-viewport.js";
import { imageToInput, normalizeCaptureBufferToDip } from "../src/main/orc/browser-host.js";
import { VisualOrcExecutor } from "../src/main/orc/visual-executor.js";
import { setLogListener } from "../src/main/main-error-log.js";

test("transparent interaction overlay does not obscure page and blocks pointer/wheel/drag", () => {
  const html = buildTransparentOverlayHtml();
  assert.match(html, /background:transparent/);
  assert.doesNotMatch(html, /rgba\(15,23,42/);
  assert.doesNotMatch(html, /<button/i);
  assert.match(html, /pointerdown/);
  assert.match(html, /mousedown/);
  assert.match(html, /wheel/);
  assert.match(html, /dragstart/);
});

test("1024x560 capture and DPR normalization preserve 1:1 DIP coordinate alignment", async () => {
  const bounds = { x: 0, y: 0, width: 1024, height: 560 };

  // 1x DPI: untouched 1024x560
  const png1x = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
  const norm1x = await normalizeCaptureBufferToDip(png1x, bounds, 1);
  assert.equal(norm1x.width, 1024);
  assert.equal(norm1x.height, 560);

  // 1.25x Windows DPI: 1280x700 physical capture normalized to 1024x560 DIPs
  const png125 = await sharp({
    create: { width: 1280, height: 700, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
  const norm125 = await normalizeCaptureBufferToDip(png125, bounds, 1.25);
  assert.equal(norm125.width, 1024);
  assert.equal(norm125.height, 560);
  assert.equal(norm125.rawWidth, 1280);
  assert.equal(norm125.rawHeight, 700);

  // Coordinate mapping at 1024x560 is 1:1
  assert.deepEqual(imageToInput(512, 280, norm125.width, norm125.height, bounds), {
    x: 512,
    y: 280,
  });
});

test("VisualOrcExecutor emits sanitized ORC_STEP_DIAGNOSTIC without leaking secrets", async () => {
  const framePng = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const templatePng = await sharp({
    create: { width: 80, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  const logs: string[] = [];
  setLogListener((entry) => logs.push(entry.message));

  try {
    const fakeHost = {
      bounds: { x: 0, y: 0, width: 1024, height: 560 },
      zoom: 1,
      deviceScaleFactor: 1.25,
      webContents: { isDestroyed: () => false },
      getSanitizedUrl: () => "https://maytuicanvas.com/wp-login.php",
      setZoom: async () => {},
      capture: async () => ({
        id: "cap-1",
        width: 1024,
        height: 560,
        zoom: 1,
        url: "https://maytuicanvas.com/wp-login.php?secret=should_not_appear",
        timestamp: new Date().toISOString(),
        backend: "cdp-surface",
        dataUrl: "",
        bounds: { x: 0, y: 0, width: 1024, height: 560 },
      }),
      captureBuffer: () => framePng,
    };

    const fakeOcr = {
      recognize: async () => ({
        text: "Log In Username",
        segments: [{ text: "Other", bbox: { x: 10, y: 10, width: 40, height: 20 }, confidence: 95 }],
      }),
    };

    const exec = new VisualOrcExecutor(fakeHost as never, fakeOcr as never);
    const out = await exec.executeVisualStep({
      stepId: "step-0-username",
      text: "super_secret_password_value",
      template: templatePng,
      payload: {
        action: "CLICK_AND_TYPE",
        target: {
          asset: "asset-1",
          roi: { x: 400, y: 200, width: 80, height: 32 },
          environment: { width: 1024, height: 560, zoom: 1 },
          matchTo: "none",
          ocr: {
            kind: "line",
            text: "Username or Email Address",
            bbox: { x: 400, y: 200, width: 80, height: 32 },
            confidence: 95,
            language: "vie+eng",
            confirmed: true,
          },
        },
      },
    });

    assert.equal(out.kind, "blocked");
    assert.match(out.message, /NOT_FOUND/);

    const diag = logs.find((m) => m.startsWith("ORC_STEP_DIAGNOSTIC "));
    assert.ok(diag, "Expected ORC_STEP_DIAGNOSTIC log");
    assert.match(diag!, /"stepId":"step-0-username"/);
    assert.match(diag!, /"currentUrl":"https:\/\/maytuicanvas\.com\/wp-login\.php"/);
    assert.match(diag!, /"viewportWidth":1024/);
    assert.match(diag!, /"viewportHeight":560/);
    assert.match(diag!, /"capturedWidth":1024/);
    assert.match(diag!, /"capturedHeight":560/);
    assert.match(diag!, /"deviceScaleFactor":1.25/);
    assert.match(diag!, /"zoomFactor":1/);
    assert.match(diag!, /"templateWidth":80/);
    assert.match(diag!, /"templateHeight":32/);
    assert.match(diag!, /"candidateCount":1/);
    assert.doesNotMatch(diag!, /super_secret_password_value/);
    assert.doesNotMatch(diag!, /should_not_appear/);
  } finally {
    setLogListener(null);
  }
});
