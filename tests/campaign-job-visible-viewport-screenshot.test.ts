import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CampaignJobExecutor, type CampaignJobBrowserHost } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import { parseCampaignJobClaim, type CampaignJobClaim } from "../src/main/jobs/contracts.js";
import {
  captureAndPersistFailureScreenshot,
  isSensitiveAuthUrl,
  sanitizeArtifactUrl,
} from "../src/main/jobs/failure-screenshot.js";
import {
  EXECUTION_VIEWPORT,
  clampExecutionBounds,
  prepareWindowForExecution,
  type ExecutionWindowLike,
} from "../src/main/browser/execution-viewport.js";
import type { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";
import type { CampaignReleasePulled } from "../src/main/jobs/campaign-script-loader.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const c = parseCampaignJobClaim({
    job_id: "job-vis-1",
    attempt_id: "att-vis-1",
    campaign_id: "camp-1",
    content_id: "cnt-1",
    browser_id: "br-1",
    account_id: "acc-1",
    script_id: "wp.create_post",
    script_version: "1",
    release_id: 4,
    content_digest: CONTENT,
    execution_digest: EXEC,
    run_mode: "live",
    execution_mode: "one_account_many_jobs",
    input: { title: "Test Draft Title" },
    lease_token: "lease-1",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  });
  assert.ok(c);
  return c;
}

function makePulledRelease(): CampaignReleasePulled {
  return {
    action_tag_id: 0,
    action_tag_key: "",
    package_key: "wp.create_post",
    package_id: 10,
    kind: "action",
    is_authentication: false,
    version: "1",
    release_id: 4,
    content_digest: CONTENT,
    execution_digest: EXEC,
    schema_version: 1,
    status: "published",
    assets_complete: true,
    ready_to_execute: true,
    manifest: {
      variables: [{ key: "title", type: "text" }],
      steps: [{ id: "step-0", action: "click_and_type", variable_key: "title" }],
    },
  };
}

test("Task A & B: CampaignJobExecutor restores/maximizes window, switches tab, verifies 1024x560 viewport before runner", async () => {
  const callOrder: string[] = [];
  const resultBodies: Array<Record<string, unknown>> = [];

  const api = new CampaignJobApi({
    isOnline: () => true,
    requestWithAuth: async (reqPath, _method, body) => {
      if (reqPath.endsWith("/result")) {
        resultBodies.push(body as Record<string, unknown>);
      }
      return { ok: true, data: {} };
    },
  });

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePulledRelease(),
    pinned: {
      package_key: "wp.create_post",
      version: "1",
      release_id: 4,
      content_digest: CONTENT,
      execution_digest: EXEC,
    },
  }));

  const fakeWebContents = {
    isDestroyed: () => false,
    getURL: () => "https://maytuicanvas.com/wp-admin/post-new.php",
    executeJavaScript: async () => ({
      titleMatched: true,
      draftStatusHint: true,
      bodySnippet: "Test Draft Title",
    }),
  } as unknown as Electron.WebContents;

  const host: CampaignJobBrowserHost = {
    async prepareForExecution(browserId) {
      callOrder.push(`prepare:${browserId}`);
    },
    async open(browserId) {
      callOrder.push(`open:${browserId}`);
    },
    getWebContents: () => fakeWebContents,
    getAuthState: () => ({ code: "SESSION_VALID", checkpointStatus: "present", message: "ok" }),
    getBounds: () => ({ x: 240, y: 110, width: 1024, height: 560 }),
    applyViewport: () => {
      callOrder.push("applyViewport");
    },
    restoreViewport: () => {
      callOrder.push("restoreViewport");
    },
    async lock() {
      callOrder.push("lock");
    },
    async verifyExecutionViewport() {
      callOrder.push("verifyViewport");
      return {
        windowMaximized: true,
        visible: true,
        bounds: { x: 240, y: 110, width: 1024, height: 560 },
        innerWidth: 1024,
        innerHeight: 560,
        deviceScaleFactor: 1,
        displayScaleFactor: 1,
        zoomFactor: 1,
        layoutStable: true,
      };
    },
    async release() {
      callOrder.push("release");
    },
    findProfileForJob: () => ({
      ok: true,
      browserId: "br-1",
      accountId: "acc-1",
      partition: "persist:rpa-client-br-1",
    }),
    loadAccount: async () => ({
      accountId: "acc-1",
      username: "admin",
      email: null,
      siteUrl: "https://maytuicanvas.com",
      getPassword: async () => "secret",
    }),
  };

  const runner = {
    async run() {
      callOrder.push("runner");
      return { kind: "ok", stepsExecuted: 1 };
    },
  } as unknown as AuthScriptRunner;

  const executor = new CampaignJobExecutor(api, loader, host, runner);
  const out = await executor.execute(makeClaim());

  assert.equal(out.status, "succeeded");
  assert.deepEqual(callOrder.slice(0, 5), [
    "prepare:br-1",
    "open:br-1",
    "lock",
    "verifyViewport",
    "runner",
  ]);
  assert.equal(callOrder[callOrder.length - 1], "release");
  assert.equal(resultBodies.length, 1);
});

test("Task A & B: prepareWindowForExecution restores, maximizes, focuses, and signals renderer", async () => {
  let restored = false;
  let shown = false;
  let maximized = false;
  let focused = false;
  const sentMessages: Array<{ channel: string; payload: unknown }> = [];

  const fakeWindow: ExecutionWindowLike = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => {
      restored = true;
    },
    show: () => {
      shown = true;
    },
    isMaximized: () => maximized,
    maximize: () => {
      maximized = true;
    },
    focus: () => {
      focused = true;
    },
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        sentMessages.push({ channel, payload });
      },
    },
  };

  const res = prepareWindowForExecution(fakeWindow, "br-123");

  assert.equal(restored, true);
  assert.equal(shown, true);
  assert.equal(maximized, true);
  assert.equal(res.windowMaximized, true);
  assert.equal(focused, true);
  assert.deepEqual(sentMessages, [
    { channel: "client:focus-browser-tab", payload: { browserId: "br-123" } },
  ]);

  // Viewport clamping preserves 1024x560 regardless of maximized window dimensions
  const clamped = clampExecutionBounds({ x: 250, y: 120, width: 1600, height: 900 });
  assert.deepEqual(clamped, {
    x: 250,
    y: 120,
    width: EXECUTION_VIEWPORT.width,
    height: EXECUTION_VIEWPORT.height,
  });
});

test("Task D: Failure screenshot captured before release for ORC_ERROR, AUTH_EXECUTION_FAILED, NOT_FOUND", async () => {
  for (const scenario of [
    { name: "ORC_ERROR / NOT_FOUND", authFail: false, runKind: "error" as const, expectedCode: "ORC_ERROR" },
    { name: "AUTH_EXECUTION_FAILED", authFail: true, runKind: "ok" as const, expectedCode: "AUTH_EXECUTION_FAILED" },
  ]) {
    const events: string[] = [];
    const resultBodies: Array<Record<string, unknown>> = [];

    const api = new CampaignJobApi({
      isOnline: () => true,
      requestWithAuth: async (reqPath, _method, body) => {
        if (reqPath.endsWith("/result")) {
          resultBodies.push(body as Record<string, unknown>);
        }
        return { ok: true, data: {} };
      },
    });

    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok",
      release: makePulledRelease(),
      pinned: {
        package_key: "wp.create_post",
        version: "1",
        release_id: 4,
        content_digest: CONTENT,
        execution_digest: EXEC,
      },
    }));

    const fakeWebContents = {
      isDestroyed: () => false,
      getURL: () => "https://maytuicanvas.com/wp-admin/update-core.php",
    } as unknown as Electron.WebContents;

    const host: CampaignJobBrowserHost = {
      async open() {},
      getWebContents: () => fakeWebContents,
      getAuthState: () =>
        scenario.authFail
          ? { code: "AUTH_EXECUTION_FAILED", checkpointStatus: "absent", message: "Step 3: NOT_FOUND" }
          : { code: "SESSION_VALID", checkpointStatus: "present", message: "ok" },
      getBounds: () => ({ x: 240, y: 110, width: 1024, height: 560 }),
      applyViewport: () => {},
      restoreViewport: () => {},
      async lock() {},
      async release() {
        events.push("release");
      },
      async captureFailureScreenshot({ jobId, attemptId, code }) {
        events.push(`capture:${jobId}:${attemptId}:${code}`);
        return {
          status: "captured",
          kind: "failure_screenshot",
          job_id: jobId,
          attempt_id: attemptId,
          error_code: code,
          mime_type: "image/png",
          sha256: "c".repeat(64),
          size_bytes: 1234,
          width: 1024,
          height: 560,
          local_path: `/tmp/${jobId}_${attemptId}.png`,
          url: "https://maytuicanvas.com/wp-admin/update-core.php",
          redacted: scenario.authFail,
          captured_at: new Date().toISOString(),
        };
      },
      findProfileForJob: () => ({
        ok: true,
        browserId: "br-1",
        accountId: "acc-1",
        partition: "persist:rpa-client-br-1",
      }),
      loadAccount: async () => ({
        accountId: "acc-1",
        username: "admin",
        email: null,
        siteUrl: "https://maytuicanvas.com",
        getPassword: async () => "secret",
      }),
    };

    const runner = {
      async run() {
        return scenario.runKind === "error"
          ? { kind: "error", message: "Step 0: NOT_FOUND: không có ứng viên chữ phù hợp.", stepsExecuted: 0 }
          : { kind: "ok", stepsExecuted: 1 };
      },
    } as unknown as AuthScriptRunner;

    const executor = new CampaignJobExecutor(api, loader, host, runner);
    const out = await executor.execute(makeClaim({ job_id: `job-${scenario.expectedCode}`, attempt_id: "att-99" }));

    assert.equal(out.status, "failed");
    assert.equal(out.code, scenario.expectedCode);
    assert.equal(events[0], `capture:job-${scenario.expectedCode}:att-99:${scenario.expectedCode}`);
    if (!scenario.authFail) {
      assert.equal(events[1], "release");
    }
    assert.equal(resultBodies.length, 1);
    const artifacts = resultBodies[0].artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].job_id, `job-${scenario.expectedCode}`);
    assert.equal(artifacts[0].attempt_id, "att-99");
    assert.equal(artifacts[0].status, "captured");
  }
});

test("Task D: captureAndPersistFailureScreenshot redacts password fields and suppresses uninspected login screens", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rpa-shot-"));
  try {
    const rawPng = await sharp({
      create: {
        width: 1024,
        height: 560,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const wcLogin = {
      isDestroyed: () => false,
      getURL: () => "https://baloquatang.net/wp-login.php?redirect_to=secret",
    } as unknown as Electron.WebContents;

    // 1. Redacts password rect and strips query string from URL
    const shot = await captureAndPersistFailureScreenshot({
      webContents: wcLogin,
      jobId: "job-auth-1",
      attemptId: "att-auth-1",
      errorCode: "AUTH_EXECUTION_FAILED",
      artifactsDir: dir,
      capturePage: async () => rawPng,
      inspectSensitiveScreen: async () => ({
        isLoginUrl: true,
        hasPasswordField: true,
        viewportWidth: 1024,
        viewportHeight: 560,
        rects: [{ x: 350, y: 240, width: 280, height: 40 }],
      }),
    });

    assert.equal(shot.status, "captured");
    assert.equal(shot.redacted, true);
    assert.equal(shot.url, "https://baloquatang.net/wp-login.php");
    assert.equal(shot.width, 1024);
    assert.equal(shot.height, 560);
    assert.ok(shot.local_path);
    const savedBytes = readFileSync(shot.local_path!);
    assert.ok(savedBytes.length > 0);
    assert.notDeepEqual(savedBytes, rawPng);

    // 2. Suppresses screenshot when DOM probe fails on sensitive login screen
    const suppressed = await captureAndPersistFailureScreenshot({
      webContents: wcLogin,
      jobId: "job-auth-2",
      attemptId: "att-auth-2",
      errorCode: "AUTH_EXECUTION_FAILED",
      artifactsDir: dir,
      capturePage: async () => rawPng,
      inspectSensitiveScreen: async () => {
        throw new Error("DOM probe timeout");
      },
    });
    assert.equal(suppressed.status, "suppressed_sensitive_auth_screen");
    assert.equal(suppressed.redacted, true);
    assert.equal(suppressed.local_path, null);
    assert.equal(isSensitiveAuthUrl("https://baloquatang.net/wp-login.php"), true);
    assert.equal(sanitizeArtifactUrl("https://site.com/wp-login.php?token=123"), "https://site.com/wp-login.php");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task D: Original Job error is preserved even if screenshot capture AND result upload fail", async () => {
  const api = new CampaignJobApi({
    isOnline: () => true,
    requestWithAuth: async (reqPath) => {
      if (reqPath.endsWith("/result")) {
        return { ok: false, errors: ["upload_rejected"] };
      }
      return { ok: true, data: {} };
    },
  });

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePulledRelease(),
    pinned: {
      package_key: "wp.create_post",
      version: "1",
      release_id: 4,
      content_digest: CONTENT,
      execution_digest: EXEC,
    },
  }));

  const fakeWebContents = {
    isDestroyed: () => false,
    getURL: () => "https://congtybalo.com/wp-admin/",
  } as unknown as Electron.WebContents;

  const host: CampaignJobBrowserHost = {
    async open() {},
    getWebContents: () => fakeWebContents,
    getAuthState: () => ({ code: "SESSION_VALID", checkpointStatus: "present", message: "ok" }),
    getBounds: () => ({ x: 240, y: 110, width: 1024, height: 560 }),
    applyViewport: () => {},
    restoreViewport: () => {},
    async lock() {},
    async release() {},
    async captureFailureScreenshot() {
      throw new Error("capture crashed");
    },
    findProfileForJob: () => ({
      ok: true,
      browserId: "br-1",
      accountId: "acc-1",
      partition: "persist:rpa-client-br-1",
    }),
    loadAccount: async () => ({
      accountId: "acc-1",
      username: "admin",
      email: null,
      siteUrl: "https://congtybalo.com",
      getPassword: async () => "secret",
    }),
  };

  const runner = {
    async run() {
      return { kind: "error", message: "Step 0: NOT_FOUND", stepsExecuted: 0 };
    },
  } as unknown as AuthScriptRunner;

  const executor = new CampaignJobExecutor(api, loader, host, runner);
  const out = await executor.execute(makeClaim());

  assert.equal(out.reported, false);
  assert.equal(out.status, "failed");
  assert.equal(out.code, "ORC_ERROR");
  assert.equal(out.message, "Step 0: NOT_FOUND");
});
