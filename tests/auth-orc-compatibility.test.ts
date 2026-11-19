import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAuthStep,
  resolveDomSelector,
  sanitizeStepMeta,
} from "../src/main/auth/auth-step-classify.js";
import { AuthScriptRunner, describeUnsupportedStep } from "../src/main/auth/auth-script-runner.js";
import { BrowserOpenOrchestrator } from "../src/main/auth/browser-open-orchestrator.js";
import { AuthScriptResolver } from "../src/main/auth/auth-script-resolver.js";
import { AuthScriptLoader } from "../src/main/auth/auth-script-loader.js";
import type { AuthReleaseIdentity, AuthReleasePulled } from "../src/main/auth/auth-script-types.js";
import type { SessionSignal } from "../src/shared/contracts.js";

const DIGEST = "b".repeat(64);

/** Sanitized fixture shaped like Script Creator → SEO-OPS opaque script steps (PackagePublishValidator). */
function creatorOcrStep(over: Record<string, unknown> = {}) {
  return {
    id: "step-click",
    version: 2,
    name: "CLICK_TARGET",
    action: "CLICK_TARGET",
    method: "auto",
    threshold: 0.96,
    timeoutMs: 3000,
    target: {
      asset: "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png",
      roi: { x: 166, y: 313, width: 684, height: 131 },
      matchTo: "top",
      environment: { width: 1024, height: 560, zoom: 1 },
      ocr: {
        confirmed: true,
        language: "vie+eng",
        kind: "line",
        text: "[redacted-label]",
        confidence: 88,
        bbox: { x: 16, y: 13, width: 168, height: 41 },
      },
    },
    ...over,
  };
}

function baseRelease(over: Partial<AuthReleaseIdentity> = {}): AuthReleaseIdentity {
  return {
    action_tag_id: 6,
    action_tag_key: "mayhopphat.login",
    package_key: "690493bd-a830-4648-83b3-86da1533c77a",
    package_id: 1,
    kind: "script",
    is_authentication: true,
    version: "1",
    release_id: 3,
    content_digest: DIGEST,
    schema_version: 1,
    status: "published",
    runtime_compatibility: { runner_min: "2.0.0" },
    assets_complete: true,
    ready_to_execute: true,
    ...over,
  };
}

const absentSignal = (): SessionSignal => ({
  status: "absent",
  checkedAt: new Date().toISOString(),
  method: "wordpress_auth_cookie",
});

test("DOM-only target classifies as dom", () => {
  const c = classifyAuthStep({
    action: "fill",
    selector: "#user_login",
    variable_key: "user_login",
  });
  assert.equal(c.kind, "dom");
  assert.equal(c.hasOcr, false);
});

test("DOM selector + OCR metadata → dom (OCR not required)", () => {
  const c = classifyAuthStep({
    action: "fill",
    target: {
      css: "#user_pass",
      ocr: { confirmed: true, text: "[redacted]", kind: "word", confidence: 90 },
    },
    variable_key: "user_pass",
  });
  assert.equal(c.kind, "dom");
  assert.equal(c.hasCssSelector, true);
  assert.equal(c.hasOcr, true);
  assert.match(c.reason, /OCR/);
  assert.equal(describeUnsupportedStep({
    action: "fill",
    target: { css: "#user_pass", ocr: { confirmed: true } },
    variable_key: "user_pass",
  }), null);
});

test("OCR-required Creator CLICK_TARGET (asset/roi/matchTo) → orc_visual", () => {
  const c = classifyAuthStep(creatorOcrStep());
  assert.equal(c.kind, "orc_visual");
  assert.equal(c.hasCssSelector, false);
  assert.equal(c.hasOcr, true);
  assert.equal(c.hasImageAsset, true);
  assert.equal(c.matchTo, "top");
  assert.equal(resolveDomSelector(creatorOcrStep()), "");
});

test("Image Match-To without CSS → orc_visual (no CSS invention)", () => {
  const step = {
    action: "CLICK_TARGET",
    target: {
      asset: "roi.png",
      roi: { x: 0, y: 0, width: 10, height: 10 },
      matchTo: "middle",
      ocr: { confirmed: true, text: "x", kind: "line", confidence: 90 },
    },
  };
  const c = classifyAuthStep(step);
  assert.equal(c.kind, "orc_visual");
  assert.equal(resolveDomSelector(step), "");
});

test("sanitizeStepMeta never includes OCR text / secrets", () => {
  const meta = sanitizeStepMeta(creatorOcrStep(), 0);
  const raw = JSON.stringify(meta);
  assert.equal(meta.stepIndex, 0);
  assert.equal(meta.kind, "orc_visual");
  assert.doesNotMatch(raw, /redacted-label/);
  assert.doesNotMatch(raw, /password|user_pass|secret/i);
});

test("AuthScriptRunner returns ASSET_DOWNLOAD_UNAVAILABLE when ORC needs assets but download missing", async () => {
  const release: AuthReleasePulled = {
    ...baseRelease(),
    manifest: {
      script_id: "dd",
      variables: [
        { id: "v1", key: "user_login", type: "text" },
        { id: "v2", key: "user_pass", type: "text" },
      ],
      steps: [
        creatorOcrStep(),
        {
          id: "s2",
          action: "CLICK_AND_TYPE",
          variable_key: "user_login",
          target: {
            asset: "a.png",
            roi: { x: 1, y: 1, width: 2, height: 2 },
            matchTo: "none",
            ocr: { confirmed: true, text: "[u]", kind: "line", confidence: 95 },
          },
        },
        {
          id: "s3",
          action: "CLICK_AND_TYPE",
          variable_key: "user_pass",
          target: {
            asset: "b.png",
            roi: { x: 1, y: 1, width: 2, height: 2 },
            ocr: { confirmed: true, text: "[p]", kind: "line", confidence: 95 },
          },
        },
        {
          id: "s4",
          action: "CLICK_TARGET",
          target: {
            asset: "c.png",
            roi: { x: 1, y: 1, width: 2, height: 2 },
            ocr: { confirmed: true, text: "[go]", kind: "line", confidence: 95 },
          },
        },
      ],
      assets: [
        { path: "a.png", sha256: "aa".repeat(32), kind: "roi" },
        { path: "b.png", sha256: "bb".repeat(32), kind: "roi" },
        { path: "c.png", sha256: "cc".repeat(32), kind: "roi" },
        { path: "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png", sha256: "dd".repeat(32), kind: "roi" },
      ],
      runtime_requirements: { runner_min: "2.0.0" },
    },
  };

  const runner = new AuthScriptRunner();
  const out = await runner.run({
    webContents: { isDestroyed: () => false } as never,
    release,
    account: {
      accountId: "acc",
      username: "mayhopphat",
      getPassword: async () => "x",
    },
  });
  assert.equal(out.kind, "asset_unavailable");
  if (out.kind === "asset_unavailable") {
    assert.equal(out.code, "ASSET_DOWNLOAD_UNAVAILABLE");
    assert.match(out.message, /auth\/asset|CONTRACT GAP/i);
    assert.doesNotMatch(out.message, /password|user_pass=|Bearer/i);
  }
});

test("AuthScriptRunner with 404 asset endpoint → ASSET_DOWNLOAD_UNAVAILABLE (no fake ORC)", async () => {
  const release: AuthReleasePulled = {
    ...baseRelease(),
    manifest: {
      steps: [creatorOcrStep()],
      variables: [],
      assets: [{ path: "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png", sha256: "dd".repeat(32), kind: "roi" }],
    },
  };
  const runner = new AuthScriptRunner();
  const out = await runner.run({
    webContents: { isDestroyed: () => false } as never,
    release,
    account: { accountId: "acc", getPassword: async () => "x" },
    downloadAsset: async () => ({ status: 404, body: { error: "not_found" } }),
  });
  assert.equal(out.kind, "asset_unavailable");
  if (out.kind === "asset_unavailable") {
    assert.equal(out.code, "ASSET_DOWNLOAD_UNAVAILABLE");
  }
});

test("Orchestrator maps asset_unavailable → ASSET_DOWNLOAD_UNAVAILABLE (no fake PASS)", async () => {
  const expected = baseRelease();
  const full: AuthReleasePulled = {
    ...expected,
    manifest: {
      steps: [creatorOcrStep()],
      variables: [],
      assets: [{ path: "x.png", sha256: "ab".repeat(32), kind: "roi" }],
    },
  };
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async (path: string) => {
      if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
      return { ok: true, release: full };
    },
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b-orc",
    accountId: "acc-1",
    partition: "persist:x",
    tag: { actionTagId: 6, actionTagKey: "mayhopphat.login" },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "ASSET_DOWNLOAD_UNAVAILABLE");
  assert.equal(result.authExecutionOk, false);
  assert.equal(result.authRuns, 1);
  assert.notEqual(result.code, "CHECKPOINT_PASSED");
});

test("Assets missing / incomplete still fail at pull (loader gate)", async () => {
  const expected = baseRelease({ assets_complete: false, ready_to_execute: false });
  const full: AuthReleasePulled = {
    ...expected,
    manifest: { steps: [creatorOcrStep()], variables: [], assets: [] },
  };
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async (path: string) => {
      if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
      return { ok: true, release: full };
    },
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b-assets",
    accountId: "acc-1",
    partition: "persist:x",
    tag: { actionTagId: 6 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "AUTH_DOWNLOAD_FAILED");
});

test("DOM-only + DOM selector with OCR metadata execute via DOM path (not ORC reject)", async () => {
  const calls: string[] = [];
  const release: AuthReleasePulled = {
    ...baseRelease(),
    manifest: {
      steps: [
        { action: "fill", selector: "#user_login", variable_key: "user_login" },
        {
          action: "fill",
          target: {
            css: "#user_pass",
            ocr: { confirmed: true, text: "[redacted]", kind: "word", confidence: 91 },
          },
          variable_key: "user_pass",
        },
        { action: "click", target: { selector: "#wp-submit" } },
      ],
      variables: [
        { key: "user_login", type: "text" },
        { key: "user_pass", type: "text" },
      ],
      assets: [],
    },
  };
  const runner = new AuthScriptRunner();
  const out = await runner.run({
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        calls.push(code.includes("user_pass") || code.includes("#user_pass") ? "pass" : "js");
        if (code.includes("document.querySelector")) return true;
        if (code.includes("captcha") || code.includes("innerText")) return null;
        return true;
      },
    } as never,
    release,
    account: {
      accountId: "a",
      username: "editor",
      getPassword: async () => "secret-not-logged",
    },
  });
  assert.equal(out.kind, "ok");
  if (out.kind === "ok") assert.equal(out.stepsExecuted, 3);
  assert.ok(calls.length > 0);
});

test("Cancel during execution still supported (AbortSignal)", async () => {
  const release: AuthReleasePulled = {
    ...baseRelease(),
    manifest: {
      steps: [
        { action: "wait", ms: 30_000 },
        { action: "fill", selector: "#user_login", variable_key: "user_login" },
      ],
      variables: [{ key: "user_login", type: "text" }],
    },
  };
  const ac = new AbortController();
  ac.abort();
  const runner = new AuthScriptRunner();
  const out = await runner.run({
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => false,
    } as never,
    release,
    account: { accountId: "a", username: "u", getPassword: async () => "x" },
    signal: ac.signal,
  });
  assert.equal(out.kind, "cancelled");
});

test("Checkpoint after Auth remains authoritative (ORC gap ≠ fake SESSION_VALID)", async () => {
  const expected = baseRelease();
  const full: AuthReleasePulled = {
    ...expected,
    manifest: { steps: [creatorOcrStep()], variables: [], assets: [{ path: "x.png", sha256: "ab".repeat(32) }] },
  };
  let checkpoints = 0;
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async (path: string) => {
      if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
      return { ok: true, release: full };
    },
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b-cp",
    accountId: "acc-1",
    partition: "persist:x",
    tag: { actionTagId: 6 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => {
      checkpoints += 1;
      return absentSignal();
    },
  });
  assert.equal(result.code, "ASSET_DOWNLOAD_UNAVAILABLE");
  assert.equal(checkpoints, 2, "checkpoint-first + post-asset-gap checkpoint");
  assert.equal(result.checkpointStatus, "absent");
  assert.notEqual(result.code, "CHECKPOINT_PASSED");
});

test("Overlay interaction-lock contract file remains present", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.cwd());
  const lockSrc = await fs.readFile(
    path.join(root, "src/main/browser/browser-interaction-lock.ts"),
    "utf8"
  );
  assert.match(lockSrc, /WebContentsView/);
  assert.match(lockSrc, /interaction.?lock|InteractionLock/i);
});
