import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { AuthScriptRunner, type AuthRunOutcome } from "../src/main/auth/auth-script-runner.js";
import type { AccountCredentialSource } from "../src/main/auth/credential-mapper.js";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import {
  CampaignJobExecutor,
  type CampaignJobBrowserHost,
} from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import {
  parseCampaignJobClaim,
  resolveScriptVariantsWithPreference,
  type CampaignJobClaim,
} from "../src/main/jobs/contracts.js";
import { captureAndPersistFailureScreenshot } from "../src/main/jobs/failure-screenshot.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";

const VI_CONTENT_DIGEST = "1".repeat(64);
const VI_EXEC_DIGEST = "2".repeat(64);
const EN_CONTENT_DIGEST = "3".repeat(64);
const EN_EXEC_DIGEST = "4".repeat(64);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const raw = {
    plan_version: 2,
    plan_tag_id: 77,
    action_tag_key: "baloquatang.create_post",
    site_key: "baloquatang.net",
    job_id: "job-pref-100",
    attempt_id: "att-pref-100",
    campaign_id: "camp-pref-100",
    content_id: "cnt-pref-100",
    browser_id: "br-1",
    account_id: "acc-1",
    script_id: "wp_vi_create_post",
    script_version: "1.0.0",
    package_key: "wp_vi_create_post",
    release_id: 101,
    content_digest: VI_CONTENT_DIGEST,
    execution_digest: VI_EXEC_DIGEST,
    run_mode: "live",
    execution_mode: "one_account_one_job",
    input: { title: "Preferred Variant Title", body: "Body" },
    lease_token: "lease-pref-100",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    execution_context: {
      resolved_url: "https://baloquatang.net/wp-admin/post-new.php",
      source: "wp_admin",
    },
    variant_group_id: "vg-uuid-pref",
    script_variants: [
      {
        variant_id: "var-vi",
        priority: 1,
        language_label: "VI",
        package_key: "wp_vi_create_post",
        release_id: 101,
        script_version: "1.0.0",
        content_digest: VI_CONTENT_DIGEST,
        execution_digest: VI_EXEC_DIGEST,
      },
      {
        variant_id: "var-en",
        priority: 2,
        language_label: "EN",
        package_key: "wp_en_create_post",
        release_id: 102,
        script_version: "1.0.0",
        content_digest: EN_CONTENT_DIGEST,
        execution_digest: EN_EXEC_DIGEST,
      },
    ],
    fallback_policy: {
      allowed_only_on: "first_step_not_found_before_mutation",
      single_attempt_identity: true,
      success_screenshots: 1,
      failure_screenshots_per_attempted_variant: 1,
    },
    ...overrides,
  };
  const parsed = parseCampaignJobClaim(raw);
  assert.ok(parsed, "Claim must parse");
  return parsed;
}

function makeFakeWebContents(draftVerified = true): WebContents {
  return {
    isDestroyed: () => false,
    getURL: () => "https://baloquatang.net/wp-admin/post.php?post=999&action=edit",
    executeJavaScript: async (code: string) => {
      if (code.includes("titleMatched") || code.includes("draftStatusHint")) {
        return {
          titleMatched: draftVerified,
          draftStatusHint: draftVerified,
          bodySnippet: draftVerified ? "Draft saved" : "Not found",
        };
      }
      return { hasPasswordField: false, viewportWidth: 1024, viewportHeight: 560, rects: [] };
    },
  } as unknown as WebContents;
}

function makeHost(artifactsDir: string, wc: WebContents): CampaignJobBrowserHost {
  return {
    open: async () => undefined,
    navigate: async () => undefined,
    getWebContents: () => wc,
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true,
      browserId: "br-1",
      accountId: "acc-1",
      partition: "persist:test",
    }),
    loadAccount: async (accountId): Promise<AccountCredentialSource> => ({
      accountId,
      username: "wp_admin",
      siteUrl: "https://baloquatang.net",
      getPassword: async () => "secret",
    }),
    captureFailureScreenshot: async (p) =>
      captureAndPersistFailureScreenshot({
        webContents: wc,
        jobId: p.jobId,
        attemptId: p.attemptId,
        errorCode: p.code,
        artifactsDir,
        outcome: "failed",
        variantId: p.variantId,
        languageLabel: p.languageLabel,
        packageKey: p.packageKey,
        releaseId: p.releaseId,
        priority: p.priority,
        screenshotRole: p.screenshotRole,
        failedStep: p.failedStep,
        capturePage: async () => TINY_PNG,
        inspectSensitiveScreen: async () => ({
          isLoginUrl: false,
          hasPasswordField: false,
          viewportWidth: 1024,
          viewportHeight: 560,
          rects: [],
        }),
      }),
    waitForSuccessScreenshotSettle: async () => {},
    captureSuccessScreenshot: async (p) =>
      captureAndPersistFailureScreenshot({
        webContents: wc,
        jobId: p.jobId,
        attemptId: p.attemptId,
        errorCode: "OK",
        artifactsDir,
        outcome: "success",
        variantId: p.variantId,
        languageLabel: p.languageLabel,
        packageKey: p.packageKey,
        releaseId: p.releaseId,
        priority: p.priority,
        screenshotRole: p.screenshotRole ?? "final_success",
        capturePage: async () => TINY_PNG,
        inspectSensitiveScreen: async () => ({
          isLoginUrl: false,
          hasPasswordField: false,
          viewportWidth: 1024,
          viewportHeight: 560,
          rects: [],
        }),
      }),
  };
}

function makePullLoader(
  pulled: Array<{ package_key: string; release_id: number }>
): CampaignScriptLoader {
  return new CampaignScriptLoader(undefined, async (c) => {
    pulled.push({ package_key: c.package_key ?? c.script_id, release_id: c.release_id! });
    const isEn = c.package_key === "wp_en_create_post";
    return {
      kind: "ok",
      pinned: {
        package_key: isEn ? "wp_en_create_post" : "wp_vi_create_post",
        version: "1.0.0",
        release_id: isEn ? 102 : 101,
        content_digest: isEn ? EN_CONTENT_DIGEST : VI_CONTENT_DIGEST,
        execution_digest: isEn ? EN_EXEC_DIGEST : VI_EXEC_DIGEST,
      },
      release: {
        action_tag_id: 77,
        action_tag_key: c.action_tag_key ?? "baloquatang.create_post",
        package_id: isEn ? 2 : 1,
        package_key: isEn ? "wp_en_create_post" : "wp_vi_create_post",
        kind: "action",
        is_authentication: false,
        version: "1.0.0",
        release_id: isEn ? 102 : 101,
        schema_version: 1,
        status: "published",
        assets_complete: true,
        ready_to_execute: true,
        content_digest: isEn ? EN_CONTENT_DIGEST : VI_CONTENT_DIGEST,
        execution_digest: isEn ? EN_EXEC_DIGEST : VI_EXEC_DIGEST,
        manifest: {
          schema_version: 1,
          steps: [],
          variables: [
            { key: "title", label: "Title", type: "string", required: true },
          ],
          assets: [],
        },
      },
    };
  });
}

function makeApiMock() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = new CampaignJobApi({
    isOnline: () => true,
    requestWithAuth: async (reqPath, _method, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      calls.push({ path: reqPath, body: b });
      if (reqPath.endsWith("/artifacts")) {
        return {
          ok: true,
          artifact: {
            artifact_uuid: `art-${calls.length}`,
            checksum_sha256: b.checksum_sha256 ?? null,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });
  return { api, calls };
}

test("1 & 7. Preferred EN -> EN executes first and EN success makes no unnecessary VI attempt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-1-"));
  try {
    const claim = makeClaim({ preferred_language_label: "EN" });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    const executed: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executed.push(p.release.package_key);
        return { kind: "ok", stepsExecuted: 3 };
      },
    } as unknown as AuthScriptRunner;

    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(claim);
    assert.equal(out.status, "succeeded");
    assert.deepEqual(executed, ["wp_en_create_post"]);
    assert.deepEqual(pulled, [{ package_key: "wp_en_create_post", release_id: 102 }]);
    assert.equal(out.selectedVariant?.variant_id, "var-en");
    assert.equal(out.selectedVariant?.language_label, "EN");

    const resultCall = calls.find((c) => c.path.endsWith("/result"));
    assert.ok(resultCall);
    const output = resultCall.body.output as Record<string, unknown>;
    assert.equal(output.variant_id, "var-en");
    assert.equal(output.language_label, "EN");
    assert.equal(output.release_id, 102);
    assert.equal(output.package_key, "wp_en_create_post");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2 & 8. Preferred VI -> VI executes first and VI success makes no unnecessary EN attempt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-2-"));
  try {
    // Even if EN has priority 1 in snapshot, preferred_variant_id = var-vi must run VI first.
    const claim = makeClaim({
      preferred_variant_id: "var-vi",
      script_variants: [
        {
          variant_id: "var-en",
          priority: 1,
          language_label: "EN",
          package_key: "wp_en_create_post",
          release_id: 102,
          script_version: "1.0.0",
          content_digest: EN_CONTENT_DIGEST,
          execution_digest: EN_EXEC_DIGEST,
        },
        {
          variant_id: "var-vi",
          priority: 2,
          language_label: "VI",
          package_key: "wp_vi_create_post",
          release_id: 101,
          script_version: "1.0.0",
          content_digest: VI_CONTENT_DIGEST,
          execution_digest: VI_EXEC_DIGEST,
        },
      ],
    });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    const executed: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executed.push(p.release.package_key);
        return { kind: "ok", stepsExecuted: 2 };
      },
    } as unknown as AuthScriptRunner;

    const { api } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(claim);
    assert.equal(out.status, "succeeded");
    assert.deepEqual(executed, ["wp_vi_create_post"]);
    assert.equal(out.selectedVariant?.variant_id, "var-vi");
    assert.equal(out.selectedVariant?.language_label, "VI");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3 & 4. Missing, invalid, or unpinned preference preserves existing default order", () => {
  const missingPref = makeClaim();
  const resMissing = resolveScriptVariantsWithPreference(missingPref);
  assert.ok(resMissing);
  assert.equal(resMissing.preference.provided, false);
  assert.deepEqual(
    resMissing.variants.map((v) => v.language_label),
    ["VI", "EN"]
  );

  const invalidLang = makeClaim({ preferred_language_label: "FR" });
  const resInvalidLang = resolveScriptVariantsWithPreference(invalidLang);
  assert.ok(resInvalidLang);
  assert.equal(resInvalidLang.preference.matched, false);
  assert.deepEqual(
    resInvalidLang.variants.map((v) => v.language_label),
    ["VI", "EN"]
  );

  const incompatiblePref = makeClaim({
    preferred_variant_id: "var-vi",
    preferred_language_label: "EN",
  });
  const resIncompat = resolveScriptVariantsWithPreference(incompatiblePref);
  assert.ok(resIncompat);
  assert.equal(resIncompat.preference.matched, false);
  assert.deepEqual(
    resIncompat.variants.map((v) => v.language_label),
    ["VI", "EN"]
  );

  const unpinnedPref = makeClaim({
    preferred_variant: {
      variant_id: "var-en",
      release_id: 999, // does not match pinned release 102
    },
  });
  const resUnpinned = resolveScriptVariantsWithPreference(unpinnedPref);
  assert.ok(resUnpinned);
  assert.equal(resUnpinned.preference.matched, false);
  assert.deepEqual(
    resUnpinned.variants.map((v) => v.language_label),
    ["VI", "EN"]
  );
});

test("5 & 12 & 13. EN safe NOT_FOUND -> VI fallback succeeds and reports VI + uploads screenshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-5-"));
  try {
    const claim = makeClaim({
      preferred_variant: { variant_id: "var-en", language_label: "EN" },
    });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    const executed: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executed.push(p.release.package_key);
        if (p.release.package_key === "wp_en_create_post") {
          return {
            kind: "error",
            message: "Step 0: NOT_FOUND",
            stepsExecuted: 0,
            stepIndex: 0,
            code: "NOT_FOUND",
            confirmedNotFound: true,
            mutated: false,
          };
        }
        return { kind: "ok", stepsExecuted: 3 };
      },
    } as unknown as AuthScriptRunner;

    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(claim);
    assert.equal(out.status, "succeeded");
    assert.equal(out.reported, true);
    assert.deepEqual(executed, ["wp_en_create_post", "wp_vi_create_post"]);
    assert.equal(out.selectedVariant?.variant_id, "var-vi");
    assert.equal(out.selectedVariant?.language_label, "VI");
    assert.equal(out.selectedVariant?.release_id, 101);

    const resultCall = calls.find((c) => c.path.endsWith("/result"));
    assert.ok(resultCall);
    const output = resultCall.body.output as Record<string, unknown>;
    assert.equal(output.variant_id, "var-vi");
    assert.equal(output.language_label, "VI");
    assert.equal(output.package_key, "wp_vi_create_post");
    assert.equal(output.release_id, 101);
    assert.equal(output.content_digest, VI_CONTENT_DIGEST);
    assert.equal(output.execution_digest, VI_EXEC_DIGEST);
    assert.equal((output.attempted_variants as unknown[]).length, 2);

    const artifactCalls = calls.filter((c) => c.path.endsWith("/artifacts"));
    assert.ok(artifactCalls.length >= 1, "Screenshot upload must succeed");
    const artifacts = resultCall.body.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1);
    assert.equal((artifacts[0].metadata as Record<string, unknown>).variant_id, "var-vi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("6. VI safe NOT_FOUND -> EN fallback succeeds and reports EN", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-6-"));
  try {
    const claim = makeClaim({ preferred_language_label: "VI" });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    const executed: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executed.push(p.release.package_key);
        if (p.release.package_key === "wp_vi_create_post") {
          return {
            kind: "error",
            message: "Step 0: NOT_FOUND",
            stepsExecuted: 0,
            stepIndex: 0,
            code: "NOT_FOUND",
            confirmedNotFound: true,
            mutated: false,
          };
        }
        return { kind: "ok", stepsExecuted: 4 };
      },
    } as unknown as AuthScriptRunner;

    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(claim);
    assert.equal(out.status, "succeeded");
    assert.deepEqual(executed, ["wp_vi_create_post", "wp_en_create_post"]);
    assert.equal(out.selectedVariant?.variant_id, "var-en");
    const resultCall = calls.find((c) => c.path.endsWith("/result"))!;
    assert.equal((resultCall.body.output as Record<string, unknown>).variant_id, "var-en");
    assert.equal((resultCall.body.output as Record<string, unknown>).release_id, 102);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("9, 10 & 11. Failure after mutation, generic failure, and unknown result never trigger fallback", async () => {
  const scenarios: Array<{ name: string; outcome: AuthRunOutcome; expectedStatus: string }> = [
    {
      name: "failure after mutation",
      outcome: {
        kind: "error",
        message: "Step 1 failed after click",
        stepsExecuted: 1,
        stepIndex: 1,
        code: "NOT_FOUND",
        confirmedNotFound: true,
        mutated: true,
      },
      expectedStatus: "failed",
    },
    {
      name: "generic OCR_ERROR without confirmedNotFound",
      outcome: {
        kind: "error",
        message: "OCR_ERROR: transient",
        stepsExecuted: 0,
        stepIndex: 0,
        code: "OCR_ERROR",
        confirmedNotFound: false,
        mutated: false,
      },
      expectedStatus: "failed",
    },
    {
      name: "unknown result (HUMAN_REQUIRED)",
      outcome: {
        kind: "human_required",
        message: "CAPTCHA detected",
        stepsExecuted: 0,
      },
      expectedStatus: "unknown",
    },
  ];

  for (const sc of scenarios) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pref-nofb-"));
    try {
      const claim = makeClaim({ preferred_language_label: "EN" });
      const pulled: Array<{ package_key: string; release_id: number }> = [];
      const executed: string[] = [];
      const runner = {
        run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
          executed.push(p.release.package_key);
          return sc.outcome;
        },
      } as unknown as AuthScriptRunner;
      const { api } = makeApiMock();
      const executor = new CampaignJobExecutor(
        api,
        makePullLoader(pulled),
        makeHost(dir, makeFakeWebContents(true)),
        runner,
        new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
      );
      const out = await executor.execute(claim);
      assert.equal(out.status, sc.expectedStatus, sc.name);
      assert.deepEqual(executed, ["wp_en_create_post"], `${sc.name} must not fallback to VI`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("14. Reconnect does not replay completed Job", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-14-"));
  try {
    const storePath = path.join(dir, "attempts.json");
    const claim = makeClaim({ preferred_language_label: "EN" });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    let runCount = 0;
    const runner = {
      run: async (): Promise<AuthRunOutcome> => {
        runCount += 1;
        return { kind: "ok", stepsExecuted: 2 };
      },
    } as unknown as AuthScriptRunner;

    const { api } = makeApiMock();
    const exec1 = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(storePath)
    );
    const first = await exec1.execute(claim);
    assert.equal(first.status, "succeeded");
    assert.equal(runCount, 1);

    // Reconnect / re-delivery of same job+attempt
    const exec2 = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(storePath)
    );
    const second = await exec2.execute(claim);
    assert.equal(second.idempotentSkip, true);
    assert.equal(runCount, 1, "Completed job must never replay on reconnect");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("15. Pinned release/digest validation remains intact even with preference", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pref-test-15-"));
  try {
    const claim = makeClaim({
      preferred_language_label: "EN",
      script_variants: [
        {
          variant_id: "var-vi",
          priority: 1,
          language_label: "VI",
          package_key: "wp_vi_create_post",
          release_id: 101,
          script_version: "1.0.0",
          content_digest: VI_CONTENT_DIGEST,
          execution_digest: VI_EXEC_DIGEST,
        },
        {
          variant_id: "var-en",
          priority: 2,
          language_label: "EN",
          package_key: "wp_en_create_post",
          // missing release_id and execution_digest -> unpinned!
        },
      ],
    });
    const pulled: Array<{ package_key: string; release_id: number }> = [];
    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      { run: async () => ({ kind: "ok", stepsExecuted: 1 }) } as unknown as AuthScriptRunner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(claim);
    assert.equal(out.code, "CONTRACT_GAP_CLAIM_PIN");
    assert.equal(pulled.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
