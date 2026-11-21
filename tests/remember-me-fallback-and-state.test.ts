import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { resolveVisualTarget, OcrNotFound, TargetNotConfident } from "../src/main/orc/target-resolver.js";
import { VisualOrcExecutor } from "../src/main/orc/visual-executor.js";
import {
  inspectWordPressRememberMeContext,
  resolveCheckboxTargetKind,
} from "../src/main/orc/checkbox-state.js";
import type { Payload } from "../src/main/orc/contracts.js";
import { setLogListener } from "../src/main/main-error-log.js";

async function makeDistinctFrameAndTemplate(opts?: { duplicate?: boolean; mismatch?: boolean }) {
  const w = 1024;
  const h = 560;
  const tw = 126;
  const th = 28;
  const rx = 365;
  const ry = 401;

  const frameBuf = Buffer.alloc(w * h * 3, 245);
  const tplBuf = Buffer.alloc(tw * th * 3, 245);

  const paintPattern = (buf: Buffer, bw: number, ox: number, oy: number) => {
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const idx = ((oy + y) * bw + (ox + x)) * 3;
        const v = (x * 7 + y * 13) % 200;
        buf[idx] = v;
        buf[idx + 1] = (v + 40) % 255;
        buf[idx + 2] = (255 - v) % 255;
      }
    }
  };

  paintPattern(tplBuf, tw, 0, 0);
  if (!opts?.mismatch) {
    paintPattern(frameBuf, w, rx, ry);
  }
  if (opts?.duplicate) {
    // Place duplicate >= 24px away vertically (outside 0.65*th=18.2) and within local search (+-64)
    paintPattern(frameBuf, w, rx + 20, ry + 32);
  }

  const frame = await sharp(frameBuf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const template = await sharp(tplBuf, { raw: { width: tw, height: th, channels: 3 } }).png().toBuffer();
  return { frame, template };
}

function makeRememberPayload(): Payload {
  return {
    action: "CLICK_TARGET",
    method: "auto",
    threshold: 0.96,
    target: {
      asset: "remember.png",
      roi: { x: 365, y: 401, width: 126, height: 28 },
      matchTo: "middle",
      environment: { width: 1024, height: 560, zoom: 1 },
      ocr: {
        kind: "word",
        text: "Remember",
        bbox: { x: 30, y: 11, width: 66, height: 11 },
        confidence: 92,
        language: "vie+eng",
        confirmed: true,
      },
    },
  };
}

test("OCR success (>= 80) resolves via OCR without template fallback", async () => {
  const { frame, template } = await makeDistinctFrameAndTemplate();
  const fakeOcr = {
    recognize: async () => ({
      text: "Remember Me",
      confidence: 91,
      language: "vie+eng" as const,
      segments: [
        { id: "s1", text: "Remember", bbox: { x: 395, y: 410, width: 66, height: 11 }, confidence: 91 },
      ],
    }),
  };
  const res = await resolveVisualTarget(frame, template, makeRememberPayload(), fakeOcr as never);
  assert.equal(res.method, "ocr");
  assert.equal(res.resolution.selectedMethod, "ocr");
});

test("OCR low confidence (< 80) falls back to strict template match (>= 0.96)", async () => {
  const { frame, template } = await makeDistinctFrameAndTemplate();
  const fakeOcr = {
    recognize: async () => ({
      text: "Remember Me",
      confidence: 72,
      language: "vie+eng" as const,
      segments: [
        { id: "s1", text: "Remember", bbox: { x: 395, y: 410, width: 66, height: 11 }, confidence: 72 },
      ],
    }),
  };
  const res = await resolveVisualTarget(frame, template, makeRememberPayload(), fakeOcr as never);
  assert.equal(res.method, "image");
  assert.equal(res.resolution.selectedMethod, "image");
  assert.equal(res.resolution.fallbackReason, "OCR_LOW_CONFIDENCE_TEMPLATE_FALLBACK");
  assert.ok(res.score >= 0.96);
});

test("OCR low confidence + template mismatch fails with OCR_LOW_CONFIDENCE", async () => {
  const { frame, template } = await makeDistinctFrameAndTemplate({ mismatch: true });
  const fakeOcr = {
    recognize: async () => ({
      text: "Remember Me",
      confidence: 65,
      language: "vie+eng" as const,
      segments: [
        { id: "s1", text: "Remember", bbox: { x: 395, y: 410, width: 66, height: 11 }, confidence: 65 },
      ],
    }),
  };
  await assert.rejects(
    () => resolveVisualTarget(frame, template, makeRememberPayload(), fakeOcr as never),
    (err: unknown) => err instanceof OcrNotFound && err.outcome === "OCR_LOW_CONFIDENCE"
  );
});

test("OCR low confidence + ambiguous template match rejects as TargetNotConfident", async () => {
  const { frame, template } = await makeDistinctFrameAndTemplate({ duplicate: true });
  const fakeOcr = {
    recognize: async () => ({
      text: "Remember Me",
      confidence: 70,
      language: "vie+eng" as const,
      segments: [
        { id: "s1", text: "Remember", bbox: { x: 395, y: 410, width: 66, height: 11 }, confidence: 70 },
      ],
    }),
  };
  await assert.rejects(
    () => resolveVisualTarget(frame, template, makeRememberPayload(), fakeOcr as never),
    (err: unknown) => err instanceof TargetNotConfident && err.ambiguous === true
  );
});

test("Remember Me execution order: verified_dom first (even with OCR_LOW_CONFIDENCE), visual_orc fallback when absent/ambiguous, origin isolation, and verify failure", async () => {
  const { frame, template } = await makeDistinctFrameAndTemplate();
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));

  try {
    let domToggleCalls = 0;
    let hostClickCalls = 0;
    let ocrCalls = 0;
    let state: "unchecked" | "checked" | "unavailable" = "unchecked";
    const fakeHost = {
      bounds: { x: 0, y: 0, width: 1024, height: 560 },
      zoom: 1,
      deviceScaleFactor: 1,
      webContents: {
        isDestroyed: () => false,
        getURL: () => "https://baloquatang.com/wp-login.php",
        executeJavaScript: async () => ({}),
        executeJavaScriptInIsolatedWorld: async () => ({
          moved: false,
          reached: true,
          searchRegion: { x: 0, y: 0, width: 1024, height: 560 },
        }),
      },
      getSanitizedUrl: () => "https://baloquatang.com/wp-login.php",
      setZoom: async () => {},
      capture: async () => ({
        id: "c1",
        width: 1024,
        height: 560,
        zoom: 1,
        url: "https://baloquatang.com/wp-login.php",
        timestamp: new Date().toISOString(),
        backend: "cdp-surface" as const,
        dataUrl: "",
        bounds: { x: 0, y: 0, width: 1024, height: 560 },
      }),
      captureBuffer: () => frame,
      click: () => {
        hostClickCalls += 1;
        state = "checked";
      },
    };
    const lowConfidenceOcr = {
      recognize: async () => {
        ocrCalls += 1;
        return {
          text: "Remember",
          confidence: 62,
          language: "vie+eng" as const,
          segments: [
            { id: "s1", text: "Remember", bbox: { x: 395, y: 410, width: 66, height: 11 }, confidence: 62 },
          ],
        };
      },
    };

    const exec = new VisualOrcExecutor(fakeHost as never, lowConfidenceOcr as never);

    // 1) Unchecked valid WordPress checkbox + would-be OCR_LOW_CONFIDENCE -> verified_dom succeeds without calling OCR
    const r1 = await exec.executeVisualStep({
      stepId: "step-2",
      stepName: "remember",
      authorizedSiteUrl: "https://baloquatang.com",
      payload: makeRememberPayload(),
      template,
      inspectCheckboxState: async () => ({ state, reason: "ok" }),
      checkCheckbox: async () => {
        domToggleCalls += 1;
        state = "checked";
        return true;
      },
    });
    assert.equal(r1.kind, "ok");
    if (r1.kind === "ok") assert.equal(r1.method, "verified_dom");
    assert.equal(domToggleCalls, 1);
    assert.equal(ocrCalls, 0);
    const d1 = logs.filter((l) => l.startsWith("ORC_STEP_DIAGNOSTIC ")).pop()!;
    assert.match(d1, /"checkboxTargetDetected":true/);
    assert.match(d1, /"checkboxStateBefore":"unchecked"/);
    assert.match(d1, /"checkboxStateAfter":"checked"/);
    assert.match(d1, /"executionMethod":"verified_dom"/);
    assert.match(d1, /"finalStepOutcome":"ok"/);

    // 2) Initially checked -> does not click or toggle again
    const r2 = await exec.executeVisualStep({
      stepId: "step-2",
      stepName: "remember",
      authorizedSiteUrl: "https://baloquatang.com",
      payload: makeRememberPayload(),
      template,
      inspectCheckboxState: async () => ({ state: "checked", reason: "ok" }),
      checkCheckbox: async () => {
        domToggleCalls += 1;
        return true;
      },
    });
    assert.equal(r2.kind, "ok");
    if (r2.kind === "ok") assert.equal(r2.method, "verified_dom");
    assert.equal(domToggleCalls, 1);

    // 3) Checkbox toggle fails to become checked -> explicit CHECKBOX_VERIFY_FAILED
    const r3 = await exec.executeVisualStep({
      stepId: "step-2",
      stepName: "remember",
      authorizedSiteUrl: "https://baloquatang.com",
      payload: makeRememberPayload(),
      template,
      inspectCheckboxState: async () => ({ state: "unchecked", reason: "ok" }),
      checkCheckbox: async () => false,
    });
    assert.equal(r3.kind, "error");
    assert.match(r3.message, /CHECKBOX_VERIFY_FAILED/);

    // 4) Checkbox absent/ambiguous -> retains strict Visual ORC matching (visual_orc) and does NOT silently skip
    const r4 = await exec.executeVisualStep({
      stepId: "step-2",
      stepName: "remember",
      authorizedSiteUrl: "https://baloquatang.com",
      payload: makeRememberPayload(),
      template,
      inspectCheckboxState: async () => ({ state: "unavailable", reason: "absent" }),
    });
    assert.equal(r4.kind, "error");
    assert.match(r4.message, /CHECKBOX_VERIFY_FAILED/);
    assert.equal(hostClickCalls, 1);
    assert.equal(ocrCalls, 1);
    const d4 = logs.filter((l) => l.startsWith("ORC_STEP_DIAGNOSTIC ")).pop()!;
    assert.match(d4, /"executionMethod":"visual_orc"/);
    assert.match(d4, /"visualFallbackReason":"dom_absent"/);

    // 5) Site/Browser origin mismatch -> inspectWordPressRememberMeContext refuses DOM match
    const originCheck = await inspectWordPressRememberMeContext(
      {
        isDestroyed: () => false,
        getURL: () => "https://other-site.com/wp-login.php",
        executeJavaScript: async () => ({ state: "unchecked", reason: "ok" }),
      },
      "https://baloquatang.com"
    );
    assert.equal(originCheck.state, "unavailable");
    assert.equal(originCheck.reason, "origin_mismatch");

    // 6) Non-checkbox CLICK_TARGET (e.g. Log In) is completely unaffected
    assert.equal(
      resolveCheckboxTargetKind({ action: "CLICK_TARGET", stepName: "login", ocrText: "Log In" }),
      null
    );
  } finally {
    setLogListener(null);
  }
});
