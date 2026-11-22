import test from "node:test";
import assert from "node:assert/strict";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import { CampaignJobExecutor, type CampaignJobBrowserHost } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader, type CampaignReleasePulled } from "../src/main/jobs/campaign-script-loader.js";
import { parseCampaignJobClaim, type CampaignJobClaim } from "../src/main/jobs/contracts.js";
import type { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const c = parseCampaignJobClaim({
    job_id: "job-nav-1",
    attempt_id: "att-nav-1",
    campaign_id: "camp-1",
    content_id: "cnt-1",
    browser_id: "br-1",
    account_id: "acc-1",
    action_tag_key: "maytuicanvas.create_post",
    site_key: "maytuicanvas.com",
    script_id: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
    script_version: "1",
    release_id: 4,
    content_digest: CONTENT,
    execution_digest: EXEC,
    run_mode: "live",
    execution_mode: "one_account_many_jobs",
    input: { title: "Draft Title" },
    lease_token: "lease-1",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  });
  assert.ok(c);
  return c;
}

function makeRelease(): CampaignReleasePulled {
  return {
    action_tag_id: 42,
    action_tag_key: "maytuicanvas.create_post",
    package_key: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
    package_id: 10,
    kind: "script",
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
      steps: [
        { id: "step-0", action: "click_and_type", variable_key: "title" },
        { id: "step-1", action: "click_target" },
      ],
    },
  };
}

function makeHarness(opts: {
  initialUrl?: string;
  authState?: { code: string; checkpointStatus?: string; message: string } | null;
  pullExecutionContext?: Record<string, unknown>;
  pullResolvedUrl?: string;
  navigateError?: Error;
  omitNavigate?: boolean;
}) {
  let currentUrl = opts.initialUrl ?? "https://maytuicanvas.com/wp-admin/update-core.php";
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

  const loader = new CampaignScriptLoader({
    isOnline: () => true,
    getConnectionToken: () => "conn-tok",
    requestWithAuth: async () => ({
      ok: true,
      release: makeRelease(),
      ...(opts.pullExecutionContext ? { execution_context: opts.pullExecutionContext } : {}),
      ...(opts.pullResolvedUrl ? { resolved_url: opts.pullResolvedUrl } : {}),
    }),
  });

  const fakeWebContents = {
    isDestroyed: () => false,
    getURL: () => currentUrl,
    executeJavaScript: async () => ({
      titleMatched: true,
      draftStatusHint: true,
      bodySnippet: "Draft Title",
    }),
  } as unknown as Electron.WebContents;

  const host: CampaignJobBrowserHost = {
    async prepareForExecution(browserId) {
      events.push(`prepare:${browserId}`);
    },
    async open(browserId) {
      events.push(`open:${browserId}@${currentUrl}`);
    },
    ...(opts.omitNavigate
      ? {}
      : {
          async navigate(url: string) {
            if (opts.navigateError) {
              events.push(`navigate_error:${url}`);
              throw opts.navigateError;
            }
            currentUrl = url;
            events.push(`navigate:${url}`);
          },
        }),
    getWebContents: () => fakeWebContents,
    getAuthState: () =>
      opts.authState !== undefined
        ? opts.authState
        : { code: "SESSION_VALID", checkpointStatus: "present", message: "ok" },
    getBounds: () => ({ x: 240, y: 110, width: 1024, height: 560 }),
    applyViewport: () => {},
    restoreViewport: () => {},
    async lock() {
      events.push("lock");
    },
    async verifyExecutionViewport() {
      events.push(`verifyViewport@${currentUrl}`);
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
      events.push("release");
    },
    async captureFailureScreenshot({ jobId, attemptId, code }) {
      events.push(`screenshot:${jobId}:${attemptId}:${code}@${currentUrl}`);
      return {
        status: "captured",
        kind: "failure_screenshot",
        job_id: jobId,
        attempt_id: attemptId,
        error_code: code,
        mime_type: "image/png",
        sha256: "d".repeat(64),
        size_bytes: 512,
        width: 1024,
        height: 560,
        local_path: `/tmp/${jobId}_${attemptId}.png`,
        url: currentUrl,
        redacted: false,
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
      events.push(`runner@${currentUrl}`);
      return { kind: "ok", stepsExecuted: 2 };
    },
  } as unknown as AuthScriptRunner;

  return {
    executor: new CampaignJobExecutor(api, loader, host, runner),
    events,
    resultBodies,
  };
}

test("1 & 3. Valid session + wrong lastUrl navigates to execution_context.resolved_url before viewport check & OCR", async () => {
  const { executor, events } = makeHarness({
    initialUrl: "https://maytuicanvas.com/wp-admin/update-core.php",
    pullExecutionContext: {
      resolved_url: "https://maytuicanvas.com/wp-admin/post-new.php",
      site_url: "https://maytuicanvas.com",
      source: "action_tag",
    },
  });

  const out = await executor.execute(makeClaim());
  assert.equal(out.status, "succeeded");
  assert.deepEqual(events, [
    "prepare:br-1",
    "open:br-1@https://maytuicanvas.com/wp-admin/update-core.php",
    "navigate:https://maytuicanvas.com/wp-admin/post-new.php",
    "lock",
    "verifyViewport@https://maytuicanvas.com/wp-admin/post-new.php",
    "runner@https://maytuicanvas.com/wp-admin/post-new.php",
    "release",
  ]);
});

test("2. Expired session requiring Auth navigates to resolved_url from Claim after Auth completes", async () => {
  const { executor, events } = makeHarness({
    initialUrl: "https://maytuicanvas.com/wp-login.php",
    authState: { code: "AUTHENTICATED", checkpointStatus: "present", message: "logged in" },
  });

  const claim = makeClaim({
    execution_context: {
      resolved_url: "https://maytuicanvas.com/wp-admin/post-new.php",
      site_url: "https://maytuicanvas.com",
    },
  });

  const out = await executor.execute(claim);
  assert.equal(out.status, "succeeded");
  assert.ok(events.includes("navigate:https://maytuicanvas.com/wp-admin/post-new.php"));
  assert.ok(events.includes("runner@https://maytuicanvas.com/wp-admin/post-new.php"));
});

test("4. Already-open Browser Profile still navigates to entry URL before ORC", async () => {
  const { executor, events } = makeHarness({
    initialUrl: "https://maytuicanvas.com/wp-admin/",
    pullResolvedUrl: "https://maytuicanvas.com/wp-admin/post-new.php",
  });

  const out = await executor.execute(makeClaim());
  assert.equal(out.status, "succeeded");
  assert.equal(events[2], "navigate:https://maytuicanvas.com/wp-admin/post-new.php");
  assert.equal(events[5], "runner@https://maytuicanvas.com/wp-admin/post-new.php");
});

test("5. Missing Action entry URL fails closed with ACTION_ENTRY_URL_MISSING (never falls back to lastUrl)", async () => {
  const { executor, events, resultBodies } = makeHarness({
    initialUrl: "https://maytuicanvas.com/wp-admin/update-core.php",
  });

  const out = await executor.execute(makeClaim());
  assert.equal(out.status, "failed");
  assert.equal(out.code, "ACTION_ENTRY_URL_MISSING");
  assert.equal(events.some((e) => e.startsWith("runner")), false);
  assert.equal(events.some((e) => e.startsWith("screenshot:")), true);
  assert.equal((resultBodies[0].artifacts as Array<Record<string, unknown>>).length, 1);
});

test("5b. Invalid Action entry URL (non-HTTP) fails closed with ACTION_NAVIGATION_FAILED", async () => {
  const { executor, events } = makeHarness({
    pullExecutionContext: { resolved_url: "javascript:alert(1)" },
  });

  const out = await executor.execute(makeClaim());
  assert.equal(out.status, "failed");
  assert.equal(out.code, "ACTION_NAVIGATION_FAILED");
  assert.equal(events.some((e) => e.startsWith("navigate:")), false);
  assert.equal(events.some((e) => e.startsWith("runner")), false);
});

test("6 & 8. URL navigation failure fails closed with ACTION_NAVIGATION_FAILED and captures screenshot", async () => {
  const { executor, events, resultBodies } = makeHarness({
    initialUrl: "https://maytuicanvas.com/wp-admin/",
    pullExecutionContext: { resolved_url: "https://maytuicanvas.com/wp-admin/post-new.php" },
    navigateError: new Error("ERR_CONNECTION_TIMED_OUT"),
  });

  const out = await executor.execute(makeClaim({ job_id: "job-nav-fail", attempt_id: "att-nav-fail" }));
  assert.equal(out.status, "failed");
  assert.equal(out.code, "ACTION_NAVIGATION_FAILED");
  assert.match(out.message, /ERR_CONNECTION_TIMED_OUT/);
  assert.equal(events.some((e) => e.startsWith("runner")), false);
  assert.ok(events.includes("screenshot:job-nav-fail:att-nav-fail:ACTION_NAVIGATION_FAILED@https://maytuicanvas.com/wp-admin/"));
  const artifacts = resultBodies[0].artifacts as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].error_code, "ACTION_NAVIGATION_FAILED");
});

test("7. Wrong Site origin in resolved_url is blocked fail-closed", async () => {
  const { executor, events } = makeHarness({
    pullExecutionContext: { resolved_url: "https://evil.example/wp-admin/post-new.php" },
  });

  const out = await executor.execute(makeClaim());
  assert.equal(out.status, "failed");
  assert.equal(out.code, "ACTION_NAVIGATION_FAILED");
  assert.equal(events.some((e) => e.startsWith("navigate:")), false);
  assert.equal(events.some((e) => e.startsWith("runner")), false);
});

test("9. No duplicate execution for same (job_id, attempt_id) after terminal outcome", async () => {
  const { executor, events } = makeHarness({
    pullExecutionContext: { resolved_url: "https://maytuicanvas.com/wp-admin/post-new.php" },
  });

  const claim = makeClaim({ job_id: "job-dup-1", attempt_id: "att-dup-1" });
  const first = await executor.execute(claim);
  assert.equal(first.status, "succeeded");
  const countAfterFirst = events.length;

  const second = await executor.execute(claim);
  assert.equal(second.idempotentSkip, true);
  assert.equal(second.code, "IDEMPOTENT_SKIP");
  assert.equal(events.length, countAfterFirst);
});
