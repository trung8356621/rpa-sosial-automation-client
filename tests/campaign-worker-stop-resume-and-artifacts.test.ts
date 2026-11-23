import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CampaignJobWorker } from "../src/main/jobs/campaign-job-worker.js";
import { CampaignJobExecutor } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import { setLogListener } from "../src/main/main-error-log.js";
import type { CampaignJobClaim } from "../src/main/jobs/contracts.js";

function sampleClaim(over: Partial<CampaignJobClaim> = {}): CampaignJobClaim {
  return {
    job_id: "job-sr-1",
    attempt_id: "att-sr-1",
    campaign_id: "camp-1",
    content_id: "content-1",
    browser_id: "b1",
    account_id: "a1",
    script_id: "script-1",
    script_version: "1",
    run_mode: "test",
    execution_mode: "one_account_one_job",
    input: { title: "Title" },
    lease_token: "lease-1",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    release_id: 1,
    content_digest: "a".repeat(64),
    execution_digest: "b".repeat(64),
    ...over,
  };
}

test("1. Stopped worker does not claim; resume() emits WORKER_POLL_RESUMED and polls", async () => {
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));
  try {
    let claimCalls = 0;
    let flushCalls = 0;
    const connection = {
      isOnline: () => true,
      getState: () => ({ status: "connected", online: true, agentUuid: "agent-1" }),
      getConnectionToken: () => "tok",
      requestWithAuth: async () => ({ ok: true, data: null }),
      onStateChange: () => () => undefined,
    };
    const profileManager = {
      list: () => [{ browserId: "b1", accountBinding: { accountId: "a1" } }],
    };
    const api = {
      claim: async () => {
        claimCalls += 1;
        return { ok: true, data: null };
      },
    };
    const executor = {
      cancelActive: () => undefined,
      flushPendingResults: async () => {
        flushCalls += 1;
        return 0;
      },
      execute: async () => {
        throw new Error("no job");
      },
    };
    const worker = new CampaignJobWorker(
      connection as never,
      profileManager as never,
      api as never,
      executor as never,
      new CampaignScriptLoader(connection as never)
    );

    worker.setEnabled(false);
    worker.stopPeriodic();
    assert.equal(await worker.tick("stopped"), null);
    assert.equal(claimCalls, 0);

    worker.resume("manual_resume");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(flushCalls, 1);
    assert.equal(claimCalls, 1);
    assert.ok(logs.some((m) => m.includes("WORKER_POLL_RESUMED") && m.includes('"reason":"manual_resume"')));
    worker.destroy();
  } finally {
    setLogListener(null);
  }
});

test("2. Reconnect flushes pending results, emits WORKER_POLL_RESUMED, and never replays Unknown/completed jobs", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpa-worker-sr-"));
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));
  try {
    const store = new JobAttemptIdempotencyStore(path.join(tmpDir, "attempts.json"));
    const claim = sampleClaim();
    store.markTerminalAcknowledged(claim.job_id, claim.attempt_id, { lastDeliveryStatus: 200 });

    let scriptPulls = 0;
    let acks = 0;
    const api = {
      claim: async () => ({ ok: true, data: claim }),
      ack: async () => {
        acks += 1;
        return { ok: true, data: null };
      },
      result: async () => ({ ok: true, data: null }),
    };
    const loader = new CampaignScriptLoader(undefined, async () => {
      scriptPulls += 1;
      throw new Error("must not pull already-terminal job");
    });
    const host = {
      findProfileForJob: () => ({ ok: true as const, browserId: "b1", accountId: "a1" }),
      open: async () => undefined,
      getWebContents: () => null,
      loadAccount: async () => ({ accountId: "a1", siteUrl: "https://example.test", getPassword: async () => "" }),
      getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
      applyViewport: async () => undefined,
      restoreViewport: async () => undefined,
      release: async () => undefined,
    };
    const executor = new CampaignJobExecutor(
      api as never,
      loader,
      host as never,
      { run: async () => ({ kind: "ok", stepsExecuted: 1 }) } as never,
      store
    );

    let stateListener: ((s: { status: string; online: boolean; agentUuid: string }) => void) | null = null;
    const connection = {
      isOnline: () => true,
      getState: () => ({ status: "connected", online: true, agentUuid: "agent-1" }),
      getConnectionToken: () => "tok",
      requestWithAuth: async () => ({ ok: true, data: null }),
      onStateChange: (fn: (s: { status: string; online: boolean; agentUuid: string }) => void) => {
        stateListener = fn;
        return () => undefined;
      },
    };
    const profileManager = {
      list: () => [{ browserId: "b1", accountBinding: { accountId: "a1" } }],
    };

    const worker = new CampaignJobWorker(
      connection as never,
      profileManager as never,
      api as never,
      executor,
      loader
    );
    worker.setEnabled(true);
    stateListener!({ status: "connected", online: true, agentUuid: "agent-1" });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(scriptPulls, 0);
    assert.equal(acks, 0);
    assert.ok(logs.some((m) => m.includes("WORKER_POLL_RESUMED") && m.includes('"reason":"reconnect"')));
    assert.ok(logs.some((m) => m.includes("CAMPAIGN_JOB_IDEMPOTENT_SKIP")));
    worker.destroy();
  } finally {
    setLogListener(null);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3. Failure screenshot emits ARTIFACT_CAPTURED and preserves local file on delivery failure", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpa-art-cap-"));
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));
  try {
    const store = new JobAttemptIdempotencyStore(path.join(tmpDir, "attempts.json"));
    const claim = sampleClaim({ job_id: "job-art-1", attempt_id: "att-art-1" });
    const api = {
      ack: async () => ({ ok: true, data: null }),
      result: async () => ({ ok: false, status: 503, errors: ["unavailable"], message: "offline" }),
    };
    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "error" as const,
      code: "SCRIPT_PULL_FAILED",
      message: "pull failed",
    }));
    const host = {
      findProfileForJob: () => ({ ok: true as const, browserId: "b1", accountId: "a1" }),
      open: async () => undefined,
      getWebContents: () => null,
      loadAccount: async () => ({ accountId: "a1", siteUrl: "https://example.test", getPassword: async () => "" }),
      getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
      applyViewport: async () => undefined,
      restoreViewport: async () => undefined,
      release: async () => undefined,
      captureFailureScreenshot: async () => ({
        status: "captured" as const,
        kind: "failure_screenshot" as const,
        job_id: claim.job_id,
        attempt_id: claim.attempt_id,
        error_code: "SCRIPT_PULL_FAILED",
        mime_type: "image/png" as const,
        sha256: "c".repeat(64),
        size_bytes: 1234,
        width: 1024,
        height: 560,
        local_path: path.join(tmpDir, "shot.png"),
        url: "https://example.test",
        redacted: false,
        captured_at: new Date().toISOString(),
      }),
    };
    const executor = new CampaignJobExecutor(
      api as never,
      loader,
      host as never,
      { run: async () => ({ kind: "ok", stepsExecuted: 0 }) } as never,
      store
    );

    const out = await executor.execute(claim);
    assert.equal(out.reported, false);
    const rec = store.get(claim.job_id, claim.attempt_id);
    assert.equal(rec?.state, "terminal_pending_delivery");
    assert.equal(rec?.localScreenshotArtifact?.local_path, path.join(tmpDir, "shot.png"));
    assert.ok(
      logs.some(
        (m) =>
          m.includes("ARTIFACT_CAPTURED") &&
          m.includes('"jobId":"job-art-1"') &&
          m.includes('"binaryUploadSupported":false')
      )
    );
  } finally {
    setLogListener(null);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
