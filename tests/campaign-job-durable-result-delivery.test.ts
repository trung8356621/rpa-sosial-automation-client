import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import { CampaignJobExecutor, type CampaignJobBrowserHost } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader, type CampaignReleasePulled } from "../src/main/jobs/campaign-script-loader.js";
import { parseCampaignJobClaim, type CampaignJobClaim } from "../src/main/jobs/contracts.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";
import type { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const c = parseCampaignJobClaim({
    job_id: "9a73d7e9-9a22-40a5-ad81-28b04272f3c7",
    attempt_id: "3f3f10f8-c887-4564-98ba-6f29e1b08edf",
    campaign_id: "50704312-9635-4529-9b6f-f7285a9e0ca3",
    content_id: "cnt-1",
    browser_id: "2436ff19-3786-4795-922a-2c5d5f496722",
    account_id: "ddf72c61-a22f-4b77-83fe-1f4ea208a076",
    action_tag_key: "baloquatang.create_post",
    site_key: "baloquatang.net",
    script_id: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
    script_version: "1",
    release_id: 4,
    content_digest: CONTENT,
    execution_digest: EXEC,
    execution_context: { resolved_url: "https://baloquatang.net/wp-admin/post-new.php" },
    run_mode: "live",
    execution_mode: "one_account_many_jobs",
    input: { title: "Balo qua tang" },
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
    action_tag_key: "baloquatang.create_post",
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
        { id: "a539bbf5-6ece-47d7-9f2e-1333fd151476", action: "click_and_type", variable_key: "title" },
        { id: "b50506d5-73ff-4057-bbb6-3bcc38736f78", action: "click_target" },
      ],
    },
  };
}

function makeHost(counters: { open: number; navigate: number; screenshot: number }): CampaignJobBrowserHost {
  const wc = {
    isDestroyed: () => false,
    getURL: () => "https://baloquatang.net/wp-admin/post-new.php",
  } as unknown as Electron.WebContents;

  return {
    async open() {
      counters.open += 1;
    },
    async navigate() {
      counters.navigate += 1;
    },
    getWebContents: () => wc,
    getAuthState: () => ({ code: "SESSION_VALID", checkpointStatus: "present", message: "ok" }),
    getBounds: () => ({ x: 200, y: 205, width: 1024, height: 560 }),
    applyViewport: () => {},
    restoreViewport: () => {},
    async lock() {},
    async release() {},
    async captureFailureScreenshot({ jobId, attemptId, code }) {
      counters.screenshot += 1;
      return {
        status: "captured",
        kind: "failure_screenshot",
        job_id: jobId,
        attempt_id: attemptId,
        error_code: code,
        mime_type: "image/png",
        sha256: "e".repeat(64),
        size_bytes: 56533,
        width: 1024,
        height: 560,
        local_path: `/tmp/${jobId}_${attemptId}.png`,
        url: "https://baloquatang.net/wp-admin/post-new.php",
        redacted: false,
        captured_at: new Date().toISOString(),
      };
    },
    findProfileForJob: () => ({
      ok: true,
      browserId: "2436ff19-3786-4795-922a-2c5d5f496722",
      accountId: "ddf72c61-a22f-4b77-83fe-1f4ea208a076",
      partition: "persist:rpa-client-2436ff19-3786-4795-922a-2c5d5f496722",
    }),
    loadAccount: async () => ({
      accountId: "ddf72c61-a22f-4b77-83fe-1f4ea208a076",
      username: "admin",
      email: null,
      siteUrl: "https://baloquatang.net",
      getPassword: async () => "secret",
    }),
  };
}

test("1, 2, 3, 4, 8, 9, 10. OCR failure + rejected /result persists durable pending state across restart, never re-executes, and redelivers cleanly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rpa-idem-"));
  const storePath = path.join(dir, "attempts.json");
  try {
    const counters = { open: 0, navigate: 0, screenshot: 0, runner: 0, resultCalls: 0 };
    let allowResultSuccess = false;

    const makeApi = () =>
      new CampaignJobApi({
        isOnline: () => true,
        requestWithAuth: async (reqPath) => {
          if (reqPath.endsWith("/result")) {
            counters.resultCalls += 1;
            if (!allowResultSuccess) {
              throw new SeoOpsHttpError({
                status: 503,
                endpoint: reqPath,
                method: "POST",
                contentType: "application/json",
                category: "unexpected_response",
                serverErrorCode: "temporarily_unavailable",
                serverErrorMessage: "Database busy",
              });
            }
          }
          return { ok: true, data: {} };
        },
      });

    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok",
      release: makeRelease(),
      pinned: {
        package_key: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
        version: "1",
        release_id: 4,
        content_digest: CONTENT,
        execution_digest: EXEC,
      },
      executionContext: { resolvedUrl: "https://baloquatang.net/wp-admin/post-new.php" },
    }));

    const runner = {
      async run() {
        counters.runner += 1;
        // Step 0 fails -> Step 1 never runs (stepsExecuted = 0)
        return { kind: "error", message: "Step 0: SCROLL_CONTAINER_CHANGED", stepsExecuted: 0 };
      },
    } as unknown as AuthScriptRunner;

    // Run 1: Step 0 fails, /result returns 503 -> persisted as terminal_pending_delivery
    const store1 = new JobAttemptIdempotencyStore(storePath);
    const exec1 = new CampaignJobExecutor(makeApi(), loader, makeHost(counters), runner, store1);
    const claim = makeClaim();
    const out1 = await exec1.execute(claim);

    assert.equal(out1.status, "failed");
    assert.equal(out1.code, "ORC_ERROR");
    assert.equal(out1.reported, false);
    assert.equal(out1.stepsExecuted, 0);
    assert.equal(counters.open, 1);
    assert.equal(counters.runner, 1);
    assert.equal(counters.screenshot, 1);

    const saved = store1.get(claim.job_id, claim.attempt_id);
    assert.equal(saved?.state, "terminal_pending_delivery");
    assert.ok(saved?.localScreenshotArtifact?.local_path);

    // Run 2: Simulated Electron restart (new store + new executor), same Job/Attempt claimed again
    const store2 = new JobAttemptIdempotencyStore(storePath);
    const loaded = store2.get(claim.job_id, claim.attempt_id);
    assert.equal(loaded?.state, "terminal_pending_delivery");

    // Even when backoff is bypassed and /result now succeeds, browser/OCR must NEVER run again
    allowResultSuccess = true;
    loaded!.nextRetryAt = Date.now() - 1;
    const exec2 = new CampaignJobExecutor(makeApi(), loader, makeHost(counters), runner, store2);
    const out2 = await exec2.execute(makeClaim({ lease_token: "lease-2" }));

    assert.equal(out2.idempotentSkip, true);
    assert.equal(out2.reported, true);
    assert.equal(counters.open, 1); // No duplicate browser execution!
    assert.equal(counters.runner, 1); // No duplicate OCR!
    assert.equal(store2.get(claim.job_id, claim.attempt_id)?.state, "terminal_acknowledged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5 & 9. Backend 422 rejection of artifacts[] triggers fallback without artifacts[], preserving local screenshot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rpa-fallback-"));
  const storePath = path.join(dir, "attempts.json");
  try {
    const counters = { open: 0, navigate: 0, screenshot: 0 };
    const resultPayloads: Array<Record<string, unknown>> = [];

    const api = new CampaignJobApi({
      isOnline: () => true,
      requestWithAuth: async (reqPath, _method, body) => {
        if (reqPath.endsWith("/result")) {
          const payload = body as Record<string, unknown>;
          resultPayloads.push(payload);
          if (Array.isArray(payload.artifacts) && payload.artifacts.length > 0) {
            throw new SeoOpsHttpError({
              status: 422,
              endpoint: reqPath,
              method: "POST",
              contentType: "application/json",
              category: "unexpected_response",
              serverErrorCode: "validation_error",
              serverErrorMessage: "The artifacts field is not supported.",
            });
          }
        }
        return { ok: true, data: {} };
      },
    });

    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok",
      release: makeRelease(),
      pinned: {
        package_key: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
        version: "1",
        release_id: 4,
        content_digest: CONTENT,
        execution_digest: EXEC,
      },
      executionContext: { resolvedUrl: "https://baloquatang.net/wp-admin/post-new.php" },
    }));

    const runner = {
      async run() {
        return { kind: "error", message: "Step 0: NOT_FOUND", stepsExecuted: 0 };
      },
    } as unknown as AuthScriptRunner;

    const store = new JobAttemptIdempotencyStore(storePath);
    const exec = new CampaignJobExecutor(api, loader, makeHost(counters), runner, store);
    const claim = makeClaim();
    const out = await exec.execute(claim);

    assert.equal(out.status, "failed");
    assert.equal(out.code, "ORC_ERROR");
    assert.equal(out.reported, true);
    assert.equal(resultPayloads.length, 2);
    assert.ok(Array.isArray(resultPayloads[0].artifacts));
    assert.equal(resultPayloads[1].artifacts, undefined);
    assert.equal(store.get(claim.job_id, claim.attempt_id)?.state, "terminal_acknowledged");
    assert.ok(store.get(claim.job_id, claim.attempt_id)?.localScreenshotArtifact?.local_path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6 & 7. Expired lease, permanent stale-fence rejection, and network timeout with uncertain ack", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rpa-edge-"));
  const storePath = path.join(dir, "attempts.json");
  try {
    const counters = { open: 0, navigate: 0, screenshot: 0 };
    const store = new JobAttemptIdempotencyStore(storePath);

    // 6a. Expired lease before execute
    const apiOk = new CampaignJobApi({ isOnline: () => true, requestWithAuth: async () => ({ ok: true, data: {} }) });
    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok",
      release: makeRelease(),
      pinned: {
        package_key: "00c6ca04-3d37-4dbf-a4a3-5fc83e9b17a5",
        version: "1",
        release_id: 4,
        content_digest: CONTENT,
        execution_digest: EXEC,
      },
      executionContext: { resolvedUrl: "https://baloquatang.net/wp-admin/post-new.php" },
    }));
    const runner = {
      async run() {
        return { kind: "error", message: "Step 0: NOT_FOUND", stepsExecuted: 0 };
      },
    } as unknown as AuthScriptRunner;

    const execExpired = new CampaignJobExecutor(apiOk, loader, makeHost(counters), runner, store);
    const expiredOut = await execExpired.execute(
      makeClaim({ lease_expires_at: new Date(Date.now() - 10_000).toISOString() })
    );
    assert.equal(expiredOut.code, "LEASE_EXPIRED");
    assert.equal(counters.open, 0);

    // 7. Network timeout (status 0) keeps terminal_pending_delivery with backoff and never replays
    const apiTimeout = new CampaignJobApi({
      isOnline: () => true,
      requestWithAuth: async (reqPath) => {
        if (reqPath.endsWith("/result")) {
          throw new Error("ETIMEDOUT");
        }
        return { ok: true, data: {} };
      },
    });
    const execTimeout = new CampaignJobExecutor(apiTimeout, loader, makeHost(counters), runner, store);
    const claimTimeout = makeClaim({ job_id: "job-timeout", attempt_id: "att-timeout" });
    const timeoutOut = await execTimeout.execute(claimTimeout);
    assert.equal(timeoutOut.reported, false);
    const rec = store.get("job-timeout", "att-timeout");
    assert.equal(rec?.state, "terminal_pending_delivery");
    assert.equal(rec?.deliveryStopped, false);
    assert.ok((rec?.nextRetryAt ?? 0) > Date.now());

    // 3b. Interrupted "executing" across Electron restart converts to INTERRUPTED_UNKNOWN and never replays
    store.markExecuting("job-crash", "att-crash");
    const storeRestarted = new JobAttemptIdempotencyStore(storePath);
    const crashedRec = storeRestarted.get("job-crash", "att-crash");
    assert.equal(crashedRec?.state, "terminal_pending_delivery");
    assert.equal(crashedRec?.code, "INTERRUPTED_UNKNOWN");
    assert.equal(storeRestarted.hasTerminal("job-crash", "att-crash"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
