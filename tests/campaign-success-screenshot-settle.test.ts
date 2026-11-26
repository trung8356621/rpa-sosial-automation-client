import assert from "node:assert/strict";
import test from "node:test";
import { CampaignJobExecutor, type CampaignJobBrowserHost } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import { parseCampaignJobClaim, type CampaignJobClaim } from "../src/main/jobs/contracts.js";
import {
  DOUBLE_RAF_SETTLE_SCRIPT,
  POST_ACTION_UI_SETTLE_MS,
  UI_SETTLE_HARD_CAP_MS,
  waitForBoundedUiSettle,
} from "../src/main/jobs/ui-settle.js";
import type { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";
import type { CampaignReleasePulled } from "../src/main/jobs/campaign-script-loader.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const c = parseCampaignJobClaim({
    job_id: "job-settle-1",
    attempt_id: "att-settle-1",
    campaign_id: "camp-1",
    content_id: "cnt-1",
    browser_id: "br-1",
    account_id: "acc-1",
    script_id: "qa_sandbox_facebook.create_post",
    script_version: "1",
    release_id: 4,
    content_digest: CONTENT,
    execution_digest: EXEC,
    run_mode: "test",
    execution_mode: "one_account_one_job",
    input: { title: "Sandbox caption" },
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
    package_key: "qa_sandbox_facebook.create_post",
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
      steps: [{ id: "step-publish", action: "click" }],
    },
  };
}

test("waitForBoundedUiSettle: SPA delayed visual update completes before settle returns", async () => {
  let uiReady = false;
  let clock = 0;
  const sleeps: number[] = [];

  const settlePromise = waitForBoundedUiSettle({
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => {
        // Paint settle resolves immediately; SPA visual update is delayed.
        return undefined;
      },
    },
    settleMs: 400,
    hardCapMs: 800,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (clock >= 400) uiReady = true;
    },
  });

  assert.equal(uiReady, false);
  const result = await settlePromise;
  assert.equal(uiReady, true);
  assert.equal(result.reason, "settled");
  assert.ok(result.waitedMs >= 400);
  assert.ok(sleeps.some((ms) => ms > 0));
});

test("waitForBoundedUiSettle: hard-caps when rAF is throttled (occluded WebContentsView)", async () => {
  let clock = 0;
  let rafStarted = false;
  let rafResolved = false;

  const result = await waitForBoundedUiSettle({
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code) => {
        assert.equal(code, DOUBLE_RAF_SETTLE_SCRIPT);
        rafStarted = true;
        // Never resolves — simulates occluded/throttled rAF.
        return new Promise(() => {});
      },
    },
    settleMs: 200,
    hardCapMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.equal(rafStarted, true);
  assert.equal(rafResolved, false);
  assert.ok(result.waitedMs <= 250);
  assert.ok(
    result.reason === "settled" || result.reason === "hard_cap",
    `expected bounded reason, got ${result.reason}`
  );
});

test("waitForBoundedUiSettle: does not wait on navigation APIs", async () => {
  const calls: string[] = [];
  await waitForBoundedUiSettle({
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code) => {
        calls.push(`raf:${code === DOUBLE_RAF_SETTLE_SCRIPT}`);
        return undefined;
      },
      // @ts-expect-error intentional probe — settle must not call these
      isLoading: () => {
        calls.push("isLoading");
        return true;
      },
      // @ts-expect-error intentional probe
      loadURL: async () => {
        calls.push("loadURL");
      },
      // @ts-expect-error intentional probe
      on: () => {
        calls.push("on");
      },
    } as never,
    settleMs: 50,
    hardCapMs: 100,
    now: () => 0,
    sleep: async () => {},
  });

  assert.deepEqual(calls, ["raf:true"]);
});

test("waitForBoundedUiSettle: unavailable webContents returns immediately", async () => {
  const result = await waitForBoundedUiSettle({
    webContents: null,
    settleMs: POST_ACTION_UI_SETTLE_MS,
    hardCapMs: UI_SETTLE_HARD_CAP_MS,
    sleep: async () => {
      throw new Error("sleep must not run when unavailable");
    },
  });
  assert.equal(result.reason, "unavailable");
  assert.equal(result.waitedMs, 0);
});

test("Campaign success path: settle → capture → release; screenshot before view cleanup", async () => {
  const events: string[] = [];
  const resultBodies: Array<Record<string, unknown>> = [];
  let destroyed = false;

  const api = new CampaignJobApi({
    isOnline: () => true,
    requestWithAuth: async (reqPath, _method, body) => {
      if (reqPath.endsWith("/result")) {
        resultBodies.push(body as Record<string, unknown>);
      }
      if (reqPath.includes("/artifacts")) {
        events.push("artifact_upload");
        return {
          ok: true,
          artifact: { artifact_uuid: "art-settle-1", checksum_sha256: "d".repeat(64) },
        };
      }
      return { ok: true, data: {} };
    },
  });

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePulledRelease(),
    pinned: {
      package_key: "qa_sandbox_facebook.create_post",
      version: "1",
      release_id: 4,
      content_digest: CONTENT,
      execution_digest: EXEC,
    },
  }));

  const fakeWebContents = {
    isDestroyed: () => destroyed,
    getURL: () => "https://example.test/composer",
    // Satisfy WordPress draft probe when that path is still active; settle itself is platform-agnostic.
    executeJavaScript: async () => ({
      titleMatched: true,
      draftStatusHint: true,
      bodySnippet: "Sandbox caption",
    }),
  } as unknown as Electron.WebContents;

  const host: CampaignJobBrowserHost = {
    async open() {
      events.push("open");
    },
    getWebContents: () => (destroyed ? undefined : fakeWebContents),
    getAuthState: () => ({ code: "SESSION_VALID", checkpointStatus: "present", message: "ok" }),
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => {},
    restoreViewport: () => {},
    async lock() {
      events.push("lock");
    },
    async release() {
      events.push("release");
      destroyed = true;
    },
    async waitForSuccessScreenshotSettle() {
      events.push("settle");
      assert.equal(destroyed, false, "WebContentsView must still be alive during settle");
    },
    async captureSuccessScreenshot({ jobId, attemptId }) {
      events.push("capture");
      assert.equal(destroyed, false, "WebContentsView must still be alive during capture");
      assert.equal(fakeWebContents.isDestroyed(), false);
      return {
        status: "captured",
        kind: "failure_screenshot",
        job_id: jobId,
        attempt_id: attemptId,
        error_code: "OK",
        mime_type: "image/png",
        sha256: "c".repeat(64),
        size_bytes: 2048,
        width: 1024,
        height: 560,
        local_path: `/tmp/${jobId}_${attemptId}_success.png`,
        url: "https://example.test/composer",
        redacted: false,
        captured_at: new Date().toISOString(),
        outcome: "success",
        screenshot_role: "final_success",
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
      username: "qa",
      email: null,
      siteUrl: "https://example.test",
      getPassword: async () => "secret",
    }),
  };

  const runner = {
    async run() {
      events.push("runner_ok");
      return { kind: "ok", stepsExecuted: 3 };
    },
  } as unknown as AuthScriptRunner;

  const executor = new CampaignJobExecutor(api, loader, host, runner);
  const out = await executor.execute(makeClaim());

  assert.equal(out.status, "succeeded");
  assert.equal(out.code, "OK");
  const settleIdx = events.indexOf("settle");
  const captureIdx = events.indexOf("capture");
  const releaseIdx = events.indexOf("release");
  assert.ok(settleIdx >= 0);
  assert.ok(captureIdx > settleIdx, "capture must follow settle");
  assert.ok(releaseIdx > captureIdx, "release/cleanup must follow screenshot capture");
  assert.equal(resultBodies.length, 1);
  const artifacts = resultBodies[0].artifacts as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(artifacts) && artifacts.length === 1);
  assert.equal(artifacts[0].screenshot_role ?? artifacts[0].role, "final_success");
});

test("Campaign success path: existing artifact upload behavior preserved after settle", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const tmpDir = mkdtempSync(path.join(tmpdir(), "rpa-settle-up-"));
  const pngBytes = Buffer.from("fake-success-png-bytes");
  const sha = createHash("sha256").update(pngBytes).digest("hex");
  const pngPath = path.join(tmpDir, "success.png");
  writeFileSync(pngPath, pngBytes);

  const uploads: Array<Record<string, unknown>> = [];
  const resultBodies: Array<Record<string, unknown>> = [];

  try {
    const api = {
      ack: async () => ({ ok: true as const, data: null }),
      uploadArtifact: async (_jobId: string, body: Record<string, unknown>) => {
        uploads.push(body);
        return {
          ok: true as const,
          data: { artifact_uuid: "art-up-1", checksum_sha256: sha },
          idempotent: false,
        };
      },
      result: async (_jobId: string, body: Record<string, unknown>) => {
        resultBodies.push(body);
        return { ok: true as const, data: null };
      },
    };

    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok",
      release: makePulledRelease(),
      pinned: {
        package_key: "qa_sandbox_facebook.create_post",
        version: "1",
        release_id: 4,
        content_digest: CONTENT,
        execution_digest: EXEC,
      },
    }));

    const host: CampaignJobBrowserHost = {
      async open() {},
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          getURL: () => "https://example.test/composer",
          executeJavaScript: async () => ({
            titleMatched: true,
            draftStatusHint: true,
            bodySnippet: "Sandbox caption",
          }),
        }) as unknown as Electron.WebContents,
      getAuthState: () => ({ code: "SESSION_VALID", checkpointStatus: "present", message: "ok" }),
      getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
      applyViewport: () => {},
      restoreViewport: () => {},
      async lock() {},
      async release() {},
      waitForSuccessScreenshotSettle: async () => {},
      async captureSuccessScreenshot({ jobId, attemptId }) {
        return {
          status: "captured",
          kind: "failure_screenshot",
          job_id: jobId,
          attempt_id: attemptId,
          error_code: "OK",
          mime_type: "image/png",
          sha256: sha,
          size_bytes: pngBytes.byteLength,
          width: 1024,
          height: 560,
          local_path: pngPath,
          url: "https://example.test/composer",
          redacted: false,
          captured_at: new Date().toISOString(),
          outcome: "success",
          screenshot_role: "final_success",
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
        username: "qa",
        email: null,
        siteUrl: "https://example.test",
        getPassword: async () => "secret",
      }),
    };

    const runner = {
      async run() {
        return { kind: "ok", stepsExecuted: 2 };
      },
    } as unknown as AuthScriptRunner;

    const executor = new CampaignJobExecutor(api as never, loader, host, runner);
    const out = await executor.execute(makeClaim({ job_id: "job-settle-upload" }));

    assert.equal(out.status, "succeeded");
    assert.equal(out.reported, true);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].outcome, "success");
    assert.equal(uploads[0].screenshot_role, "final_success");
    assert.equal(resultBodies.length, 1);
    const artifacts = resultBodies[0].artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].status, "captured");
    assert.equal(artifacts[0].artifact_uuid, "art-up-1");
    assert.equal(artifacts[0].upload_status, "uploaded");
    assert.equal(artifacts[0].screenshot_role, "final_success");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
