import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import { CampaignJobExecutor } from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import { setLogListener } from "../src/main/main-error-log.js";
import type { CampaignJobClaim } from "../src/main/jobs/contracts.js";
import type { AuthReleasePulled } from "../src/main/auth/auth-script-types.js";

function sampleClaim(over: Partial<CampaignJobClaim> = {}): CampaignJobClaim {
  return {
    job_id: "job-bin-1",
    attempt_id: "att-bin-1",
    campaign_id: "camp-1",
    content_id: "content-1",
    browser_id: "b1",
    account_id: "a1",
    script_id: "382f26c4-d39a-4f2d-a8a3-d255f6c65c61",
    script_version: "1",
    run_mode: "test",
    execution_mode: "one_account_one_job",
    input: { title: "TEST Mock Title #5" },
    lease_token: "lease-bin-1",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    release_id: 12,
    content_digest: "a".repeat(64),
    execution_digest: "b".repeat(64),
    ...over,
  };
}

function sampleRelease(claim: CampaignJobClaim): AuthReleasePulled & { execution_digest: string } {
  return {
    action_tag_id: 1,
    action_tag_key: "maytuicanvas.create_post",
    package_key: claim.script_id,
    package_id: 1,
    kind: "script",
    is_authentication: false,
    version: claim.script_version,
    release_id: claim.release_id ?? 12,
    content_digest: claim.content_digest!,
    execution_digest: claim.execution_digest!,
    schema_version: 1,
    status: "published",
    runtime_compatibility: null,
    assets_complete: true,
    ready_to_execute: true,
    manifest: {
      script_id: claim.script_id,
      variables: [],
      steps: [{ id: "s1", action: "navigate", url: "https://maytuicanvas.com/wp-admin/post-new.php" }],
    },
  };
}

test("1 & 2. CampaignJobApi.uploadArtifact handles 201 new upload and 200 idempotent duplicate", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const conn = {
    isOnline: () => true,
    requestWithAuth: async (subpath: string, _method: "GET" | "POST", body?: Record<string, unknown>) => {
      call += 1;
      requests.push({ path: subpath, body: body ?? {} });
      return {
        ok: true,
        idempotent: call > 1,
        artifact: {
          artifact_uuid: "art-uuid-123",
          checksum_sha256: "d".repeat(64),
        },
      };
    },
  };
  const api = new CampaignJobApi(conn);
  const res1 = await api.uploadArtifact("job-1", {
    attempt_uuid: "att-1",
    lease_token: "lease-1",
    kind: "screenshot",
    mime: "image/png",
    outcome: "success",
    phase: "final",
    content_base64: Buffer.from("png-bytes").toString("base64"),
    checksum_sha256: "d".repeat(64),
  });
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.data.artifact_uuid, "art-uuid-123");
    assert.equal(res1.idempotent, false);
  }

  const res2 = await api.uploadArtifact("job-1", {
    attempt_uuid: "att-1",
    lease_token: "lease-1",
    kind: "screenshot",
    mime: "image/png",
    outcome: "success",
    phase: "final",
    content_base64: Buffer.from("png-bytes").toString("base64"),
    checksum_sha256: "d".repeat(64),
  });
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.data.artifact_uuid, "art-uuid-123");
    assert.equal(res2.idempotent, true);
  }
  assert.equal(requests[0].path, "/api/v1/social-automation/client/jobs/job-1/artifacts");
  assert.equal(requests[0].body.attempt_uuid, "att-1");
});

test("3. Failure screenshot uploads before terminal result with variant metadata and artifact_uuid", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpa-bin-fail-"));
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));
  try {
    const pngBytes = Buffer.from("fake-png-failure-bytes");
    const sha = createHash("sha256").update(pngBytes).digest("hex");
    const pngPath = path.join(tmpDir, "fail.png");
    writeFileSync(pngPath, pngBytes);

    const claim = sampleClaim({
      variant_group_id: "vg-1",
      script_variants: [
        {
          variant_id: "var-en",
          priority: 2,
          language_label: "EN",
          package_key: "382f26c4-d39a-4f2d-a8a3-d255f6c65c61",
          release_id: 12,
          script_version: "1",
          content_digest: "a".repeat(64),
          execution_digest: "b".repeat(64),
        },
      ],
    });

    const uploadBodies: Array<Record<string, unknown>> = [];
    const resultBodies: Array<Record<string, unknown>> = [];
    const api = {
      ack: async () => ({ ok: true as const, data: null }),
      uploadArtifact: async (_jobId: string, body: Record<string, unknown>) => {
        uploadBodies.push(body);
        return {
          ok: true as const,
          data: { artifact_uuid: "art-fail-uuid-1", checksum_sha256: sha },
          idempotent: false,
        };
      },
      result: async (_jobId: string, body: Record<string, unknown>) => {
        resultBodies.push(body);
        return { ok: true as const, data: null };
      },
    };
    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok" as const,
      pinned: {
        package_key: claim.script_id,
        version: claim.script_version,
        release_id: 12,
        content_digest: "a".repeat(64),
        execution_digest: "b".repeat(64),
      },
      release: sampleRelease(claim),
    }));
    const host = {
      findProfileForJob: () => ({ ok: true as const, browserId: "b1", accountId: "a1" }),
      open: async () => undefined,
      lock: async () => undefined,
      getWebContents: () => ({ isDestroyed: () => false }),
      loadAccount: async () => ({ accountId: "a1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" }),
      getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
      applyViewport: async () => undefined,
      restoreViewport: async () => undefined,
      release: async () => undefined,
      captureFailureScreenshot: async () => ({
        status: "captured" as const,
        kind: "failure_screenshot" as const,
        job_id: claim.job_id,
        attempt_id: claim.attempt_id,
        error_code: "ORC_ERROR",
        mime_type: "image/png" as const,
        sha256: sha,
        size_bytes: pngBytes.byteLength,
        width: 1024,
        height: 560,
        local_path: pngPath,
        url: "https://maytuicanvas.com/wp-admin/post-new.php",
        redacted: false,
        captured_at: new Date().toISOString(),
        variant_id: "var-en",
        language_label: "EN",
        package_key: claim.script_id,
        release_id: 12,
        priority: 2,
        screenshot_role: "variant_failure",
        failed_step: 1,
      }),
    };
    const store = new JobAttemptIdempotencyStore(path.join(tmpDir, "attempts.json"));
    const executor = new CampaignJobExecutor(
      api as never,
      loader,
      host as never,
      { run: async () => ({ kind: "error", message: "Step 1 failed", stepsExecuted: 1, stepIndex: 1 }) } as never,
      store
    );

    const out = await executor.execute(claim);
    assert.equal(out.reported, true);
    assert.equal(uploadBodies.length, 1);
    assert.equal(uploadBodies[0].attempt_uuid, claim.attempt_id);
    assert.equal(uploadBodies[0].outcome, "failed");
    assert.equal(uploadBodies[0].variant_id, "var-en");
    assert.equal(uploadBodies[0].language_label, "EN");
    assert.equal(uploadBodies[0].release_id, 12);
    assert.equal(uploadBodies[0].screenshot_role, "variant_failure");

    const artifactsInResult = resultBodies[0].artifacts as Array<Record<string, unknown>>;
    assert.equal(artifactsInResult[0].artifact_uuid, "art-fail-uuid-1");
    assert.equal(artifactsInResult[0].binary_upload_supported, true);
    assert.equal(artifactsInResult[0].upload_status, "uploaded");

    assert.ok(logs.some((m) => m.includes("ARTIFACT_UPLOAD_STARTED")));
    assert.ok(logs.some((m) => m.includes("ARTIFACT_UPLOAD_ACKED") && m.includes("art-fail-uuid-1")));
    assert.ok(logs.some((m) => m.includes("CAMPAIGN_JOB_TERMINAL") && m.includes('"screenshotUploadStatus":"uploaded"')));
  } finally {
    setLogListener(null);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. Upload failure preserves local PNG, delivers terminal result, and reconnect retries upload only (no Script replay)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpa-bin-retry-"));
  const logs: string[] = [];
  setLogListener((e) => logs.push(e.message));
  try {
    const pngBytes = Buffer.from("fake-png-retry-bytes");
    const sha = createHash("sha256").update(pngBytes).digest("hex");
    const pngPath = path.join(tmpDir, "retry.png");
    writeFileSync(pngPath, pngBytes);

    const claim = sampleClaim({ job_id: "job-retry-1", attempt_id: "att-retry-1" });
    let scriptRuns = 0;
    let uploadAttempts = 0;
    let resultCalls = 0;

    const api = {
      ack: async () => ({ ok: true as const, data: null }),
      uploadArtifact: async () => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return { ok: false as const, status: 504, errors: ["timeout"], message: "Gateway Timeout" };
        }
        return {
          ok: true as const,
          data: { artifact_uuid: "art-retry-uuid-2", checksum_sha256: sha },
          idempotent: false,
        };
      },
      result: async () => {
        resultCalls += 1;
        return { ok: true as const, data: null };
      },
    };
    const loader = new CampaignScriptLoader(undefined, async () => ({
      kind: "ok" as const,
      pinned: {
        package_key: claim.script_id,
        version: claim.script_version,
        release_id: 12,
        content_digest: "a".repeat(64),
        execution_digest: "b".repeat(64),
      },
      release: sampleRelease(claim),
    }));
    const host = {
      findProfileForJob: () => ({ ok: true as const, browserId: "b1", accountId: "a1" }),
      open: async () => undefined,
      lock: async () => undefined,
      getWebContents: () => ({ isDestroyed: () => false }),
      loadAccount: async () => ({ accountId: "a1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" }),
      getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
      applyViewport: async () => undefined,
      restoreViewport: async () => undefined,
      release: async () => undefined,
      captureFailureScreenshot: async () => ({
        status: "captured" as const,
        kind: "failure_screenshot" as const,
        job_id: claim.job_id,
        attempt_id: claim.attempt_id,
        error_code: "ORC_ERROR",
        mime_type: "image/png" as const,
        sha256: sha,
        size_bytes: pngBytes.byteLength,
        width: 1024,
        height: 560,
        local_path: pngPath,
        url: "https://maytuicanvas.com/wp-admin/post-new.php",
        redacted: false,
        captured_at: new Date().toISOString(),
      }),
    };
    const store = new JobAttemptIdempotencyStore(path.join(tmpDir, "attempts.json"));
    const executor = new CampaignJobExecutor(
      api as never,
      loader,
      host as never,
      {
        run: async () => {
          scriptRuns += 1;
          return { kind: "error", message: "Step 0 failed", stepsExecuted: 0, stepIndex: 0 };
        },
      } as never,
      store
    );

    const out = await executor.execute(claim);
    assert.equal(out.reported, true);
    assert.equal(resultCalls, 1);
    assert.equal(uploadAttempts, 1);
    assert.equal(scriptRuns, 1);
    assert.ok(logs.some((m) => m.includes("ARTIFACT_UPLOAD_FAILED")));

    // Simulate backoff elapsed -> flushPendingResults() retries ONLY the artifact upload.
    const rec = store.get(claim.job_id, claim.attempt_id)!;
    rec.pendingArtifactUploads![0].nextRetryAt = Date.now() - 1;

    await executor.flushPendingResults();
    assert.equal(uploadAttempts, 2);
    assert.equal(scriptRuns, 1, "Script must never rerun during artifact retry");
    assert.equal(resultCalls, 1, "Already-ACKed terminal result must not be resent");

    const updated = store.get(claim.job_id, claim.attempt_id)!;
    assert.equal(updated.pendingArtifactUploads![0].uploadStatus, "uploaded");
    assert.equal(updated.pendingArtifactUploads![0].artifactUuid, "art-retry-uuid-2");

    // Calling flushPendingResults again does not duplicate upload.
    await executor.flushPendingResults();
    assert.equal(uploadAttempts, 2);
  } finally {
    setLogListener(null);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("5. Unauthorized / expired lease (401/409) stops upload retries permanently", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpa-bin-auth-"));
  try {
    const pngBytes = Buffer.from("fake-png-auth-bytes");
    const sha = createHash("sha256").update(pngBytes).digest("hex");
    const pngPath = path.join(tmpDir, "auth.png");
    writeFileSync(pngPath, pngBytes);

    const claim = sampleClaim({ job_id: "job-auth-1", attempt_id: "att-auth-1" });
    let uploadAttempts = 0;
    const api = {
      ack: async () => ({ ok: true as const, data: null }),
      uploadArtifact: async () => {
        uploadAttempts += 1;
        return { ok: false as const, status: 401, errors: ["unauthorized"], message: "Invalid API key" };
      },
      result: async () => ({ ok: true as const, data: null }),
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
      loadAccount: async () => ({ accountId: "a1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" }),
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
        sha256: sha,
        size_bytes: pngBytes.byteLength,
        width: 1024,
        height: 560,
        local_path: pngPath,
        url: "https://maytuicanvas.com",
        redacted: false,
        captured_at: new Date().toISOString(),
      }),
    };
    const store = new JobAttemptIdempotencyStore(path.join(tmpDir, "attempts.json"));
    const executor = new CampaignJobExecutor(
      api as never,
      loader,
      host as never,
      { run: async () => ({ kind: "ok", stepsExecuted: 0 }) } as never,
      store
    );

    await executor.execute(claim);
    assert.equal(uploadAttempts, 1);
    const rec = store.get(claim.job_id, claim.attempt_id)!;
    assert.equal(rec.pendingArtifactUploads![0].uploadStopped, true);

    await executor.flushPendingResults();
    assert.equal(uploadAttempts, 1, "Permanent 401/lease error must not retry");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
