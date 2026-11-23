import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { AuthScriptRunner, type AuthRunOutcome } from "../src/main/auth/auth-script-runner.js";
import type { AccountCredentialSource } from "../src/main/auth/credential-mapper.js";
import { resolveDevUserDataPath } from "../src/main/dev-instance.js";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import {
  CampaignJobExecutor,
  type CampaignJobBrowserHost,
} from "../src/main/jobs/campaign-job-executor.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import {
  parseCampaignJobClaim,
  resolveOrderedScriptVariants,
  type CampaignJobClaim,
} from "../src/main/jobs/contracts.js";
import { captureAndPersistFailureScreenshot } from "../src/main/jobs/failure-screenshot.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import { VisualOrcExecutor } from "../src/main/orc/visual-executor.js";
import { OrcBrowserHost } from "../src/main/orc/browser-host.js";
import type { OcrEngine } from "../src/main/orc/ocr.js";

const VI_CONTENT_DIGEST = "1".repeat(64);
const VI_EXEC_DIGEST = "2".repeat(64);
const EN_CONTENT_DIGEST = "3".repeat(64);
const EN_EXEC_DIGEST = "4".repeat(64);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makeVariantClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const raw = {
    plan_version: 2,
    plan_tag_id: 77,
    action_tag_key: "baloquatang.create_post",
    site_key: "baloquatang.net",
    job_id: "job-vg-100",
    attempt_id: "att-vg-100",
    campaign_id: "camp-vg-100",
    content_id: "cnt-vg-100",
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
    input: { title: "Variant Test Title", body: "Variant Test Body" },
    lease_token: "lease-vg-100",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    execution_context: {
      resolved_url: "https://baloquatang.net/wp-admin/post-new.php",
      source: "wp_admin",
    },
    variant_group_id: "vg-uuid-1",
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
  assert.ok(parsed, "Claim should parse cleanly");
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

function makeHost(
  artifactsDir: string,
  wc: WebContents
): CampaignJobBrowserHost {
  return {
    async open() {},
    async navigate() {},
    getWebContents: () => wc,
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport() {},
    restoreViewport() {},
    async lock() {},
    async release() {},
    findProfileForJob(claim) {
      return {
        ok: true,
        browserId: claim.browser_id,
        accountId: claim.account_id,
        partition: `persist:rpa-client-${claim.browser_id}`,
      };
    },
    async loadAccount(accountId): Promise<AccountCredentialSource> {
      return {
        accountId,
        username: "wp_admin",
        siteUrl: "https://baloquatang.net",
        getPassword: async () => "secret",
      };
    },
    async captureFailureScreenshot(p) {
      return captureAndPersistFailureScreenshot({
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
      });
    },
    async captureSuccessScreenshot(p) {
      return captureAndPersistFailureScreenshot({
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
      });
    },
  };
}

function makePullLoader(
  pulledHistory: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }>
): CampaignScriptLoader {
  return new CampaignScriptLoader(undefined, async (claim) => {
    pulledHistory.push({
      package_key: claim.script_id,
      release_id: claim.release_id!,
      job_id: claim.job_id,
      attempt_id: claim.attempt_id,
    });
    const isEn = claim.script_id === "wp_en_create_post";
    return {
      kind: "ok",
      pinned: {
        package_key: claim.script_id,
        version: claim.script_version,
        release_id: claim.release_id!,
        content_digest: isEn ? EN_CONTENT_DIGEST : VI_CONTENT_DIGEST,
        execution_digest: isEn ? EN_EXEC_DIGEST : VI_EXEC_DIGEST,
      },
      release: {
        schema_version: 1,
        action_tag_id: 1,
        action_tag_key: "baloquatang.create_post",
        package_id: isEn ? 2 : 1,
        kind: "script",
        package_key: claim.script_id,
        version: claim.script_version,
        release_id: claim.release_id!,
        content_digest: isEn ? EN_CONTENT_DIGEST : VI_CONTENT_DIGEST,
        execution_digest: isEn ? EN_EXEC_DIGEST : VI_EXEC_DIGEST,
        is_authentication: false,
        status: "published",
        assets_complete: true,
        ready_to_execute: true,
        manifest: {
          variables: [{ key: "title", label: "Title", type: "text", required: true }],
          steps: [{ action: "wait", ms: 1 }],
        },
        assets: [],
      },
    };
  });
}

function makeApiMock(opts?: { failResultOnce?: boolean }) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let resultCount = 0;
  const api = new CampaignJobApi({
    isOnline: () => true,
    requestWithAuth: async (reqPath, _method, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      calls.push({ path: reqPath, body: b });
      if (reqPath.endsWith("/result")) {
        resultCount += 1;
        if (opts?.failResultOnce && resultCount === 1) {
          throw new Error("Simulated transient network failure");
        }
      }
      return { ok: true, data: {} };
    },
  });
  return { api, calls };
}

test("1. VI succeeds immediately (respects priority order even if claim array unsorted, 1 final success screenshot)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-1-"));
  try {
    const claim = makeVariantClaim({
      // Deliberately reversed order in payload; priority 1 (VI) must run first.
      script_variants: [
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
      ],
    });
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    const executedPackages: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executedPackages.push(p.release.package_key);
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
    assert.equal(out.selectedVariant?.language_label, "VI");
    assert.deepEqual(executedPackages, ["wp_vi_create_post"]);
    assert.equal(pulled.length, 1);
    assert.equal(pulled[0].package_key, "wp_vi_create_post");

    const resultCall = calls.find((c) => c.path.endsWith("/result"));
    assert.ok(resultCall);
    assert.equal(resultCall.body.attempt_id, "att-vg-100");
    const artifacts = resultCall.body.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "screenshot");
    assert.equal(artifacts[0].mime, "image/png");
    assert.equal(artifacts[0].outcome, "success");
    const meta = artifacts[0].metadata as Record<string, unknown>;
    assert.equal(meta.phase, "final");
    assert.equal(meta.variant_id, "var-vi");
    assert.equal(meta.language_label, "VI");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2. VI first-step NOT_FOUND -> EN succeeds (same Job/Attempt ID, 1 final success screenshot only)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-2-"));
  try {
    const claim = makeVariantClaim();
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    const executedPackages: string[] = [];
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        executedPackages.push(p.release.package_key);
        if (p.release.package_key === "wp_vi_create_post") {
          return {
            kind: "error",
            message: "Step 0: NOT_FOUND: không có ứng viên chữ phù hợp",
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
    assert.equal(out.reported, true);
    assert.equal(out.selectedVariant?.language_label, "EN");
    assert.deepEqual(executedPackages, ["wp_vi_create_post", "wp_en_create_post"]);
    assert.equal(pulled.length, 2);
    assert.equal(pulled[0].job_id, "job-vg-100");
    assert.equal(pulled[0].attempt_id, "att-vg-100");
    assert.equal(pulled[1].job_id, "job-vg-100");
    assert.equal(pulled[1].attempt_id, "att-vg-100");

    // Only 1 ack and 1 result call (single job/attempt)
    assert.equal(calls.filter((c) => c.path.endsWith("/ack")).length, 1);
    const resultCalls = calls.filter((c) => c.path.endsWith("/result"));
    assert.equal(resultCalls.length, 1);
    const artifacts = resultCalls[0].body.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 1, "Success must keep only 1 final success screenshot");
    assert.equal(artifacts[0].outcome, "success");
    assert.equal((artifacts[0].metadata as Record<string, unknown>).variant_id, "var-en");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3. VI and EN both first-step NOT_FOUND -> keeps 2 failure screenshots with variant metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-3-"));
  try {
    const claim = makeVariantClaim();
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    const runner = {
      run: async (): Promise<AuthRunOutcome> => ({
        kind: "error",
        message: "Step 0: NOT_FOUND: không có ứng viên chữ phù hợp",
        stepsExecuted: 0,
        stepIndex: 0,
        code: "NOT_FOUND",
        confirmedNotFound: true,
        mutated: false,
      }),
    } as unknown as AuthScriptRunner;

    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(false)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );

    const out = await executor.execute(claim);
    assert.equal(out.status, "failed");
    assert.equal(out.code, "ORC_ERROR");
    assert.equal(out.reported, true);
    assert.equal(out.attemptedVariants?.length, 2);

    const resultCall = calls.find((c) => c.path.endsWith("/result"));
    assert.ok(resultCall);
    const artifacts = resultCall.body.artifacts as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 2, "Must keep 1 failure screenshot per attempted variant");
    assert.equal(artifacts[0].kind, "screenshot");
    assert.equal(artifacts[0].mime, "image/png");
    assert.equal(artifacts[0].outcome, "failed");
    assert.equal((artifacts[0].metadata as Record<string, unknown>).variant_id, "var-vi");
    assert.equal((artifacts[0].metadata as Record<string, unknown>).language_label, "VI");
    assert.equal((artifacts[0].metadata as Record<string, unknown>).failed_step, 0);
    assert.equal((artifacts[1].metadata as Record<string, unknown>).variant_id, "var-en");
    assert.equal((artifacts[1].metadata as Record<string, unknown>).language_label, "EN");
    assert.notEqual(artifacts[0].local_path, artifacts[1].local_path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("4. No fallback after any mutation (stepIndex > 0 or mutated=true)", async () => {
  for (const scenario of [
    { name: "step 1 after step 0 clicked", stepIndex: 1, stepsExecuted: 1, mutated: true },
    { name: "step 0 mutated via scroll", stepIndex: 0, stepsExecuted: 0, mutated: true },
  ]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-4-"));
    try {
      const claim = makeVariantClaim();
      const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
      const executedPackages: string[] = [];
      const runner = {
        run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
          executedPackages.push(p.release.package_key);
          return {
            kind: "error",
            message: `Step ${scenario.stepIndex}: NOT_FOUND`,
            stepsExecuted: scenario.stepsExecuted,
            stepIndex: scenario.stepIndex,
            code: "NOT_FOUND",
            confirmedNotFound: false,
            mutated: scenario.mutated,
          };
        },
      } as unknown as AuthScriptRunner;

      const { api, calls } = makeApiMock();
      const executor = new CampaignJobExecutor(
        api,
        makePullLoader(pulled),
        makeHost(dir, makeFakeWebContents(false)),
        runner,
        new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
      );

      const out = await executor.execute(claim);
      assert.equal(out.status, "failed", scenario.name);
      assert.deepEqual(executedPackages, ["wp_vi_create_post"], `Must not fallback for: ${scenario.name}`);
      assert.equal(pulled.length, 1);
      const resultCall = calls.find((c) => c.path.endsWith("/result"));
      const artifacts = resultCall?.body.artifacts as Array<Record<string, unknown>>;
      assert.equal(artifacts.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("5. No fallback on uncertain result (OCR_LOW_CONFIDENCE, timeout, human_required) + VisualOrcExecutor integration", async () => {
  // 5a: VisualOrcExecutor returns confirmedNotFound=false for OCR_LOW_CONFIDENCE
  const wc = makeFakeWebContents(false);
  const host = new OrcBrowserHost(wc, { x: 0, y: 0, width: 1024, height: 560 });
  host.capture = async () => ({
    id: "cap-1",
    width: 1024,
    height: 560,
    dataUrl: "data:image/png;base64,",
    zoom: 1,
    url: "https://baloquatang.net/wp-admin/post-new.php",
    timestamp: new Date().toISOString(),
    backend: "cdp-surface",
  });
  host.captureBuffer = () => TINY_PNG;
  const lowConfOcr: OcrEngine = {
    recognize: async () => ({
      text: "Bài viết",
      confidence: 45,
      language: "vie+eng",
      segments: [
        {
          id: "seg-1",
          text: "Bài viết",
          confidence: 45, // below MIN_OCR_CONFIDENCE=80 -> OCR_LOW_CONFIDENCE
          bbox: { x: 10, y: 10, width: 80, height: 20 },
        },
      ],
    }),
  };
  const orc = new VisualOrcExecutor(host, lowConfOcr);
  const stepOutcome = await orc.executeVisualStep({
    payload: {
      action: "CLICK_TARGET",
      method: "ocr",
      target: {
        asset: "btn.png",
        roi: { x: 0, y: 0, width: 1024, height: 560 },
        ocr: {
          text: "Bài viết",
          kind: "word",
          bbox: { x: 10, y: 10, width: 80, height: 20 },
          confidence: 95,
          confirmed: true,
          language: "vie+eng",
        },
      },
    },
    template: TINY_PNG,
    stepId: "step-0",
    authorizedSiteUrl: "https://baloquatang.net",
  });
  assert.equal(stepOutcome.kind, "blocked");
  if (stepOutcome.kind === "blocked") {
    assert.equal(stepOutcome.confirmedNotFound, false);
  }

  // 5b: Executor refuses fallback on timeout / human_required / TARGET_NOT_CONFIDENT
  for (const outcome of [
    { kind: "timeout", message: "Timeout", stepsExecuted: 0 } as AuthRunOutcome,
    { kind: "human_required", message: "CAPTCHA", stepsExecuted: 0 } as AuthRunOutcome,
    {
      kind: "error",
      message: "Step 0: OCR_LOW_CONFIDENCE",
      stepsExecuted: 0,
      stepIndex: 0,
      code: "TARGET_NOT_CONFIDENT",
      confirmedNotFound: false,
      mutated: false,
    } as AuthRunOutcome,
  ]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-5-"));
    try {
      const claim = makeVariantClaim();
      const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
      const runner = { run: async () => outcome } as unknown as AuthScriptRunner;
      const { api } = makeApiMock();
      const executor = new CampaignJobExecutor(
        api,
        makePullLoader(pulled),
        makeHost(dir, makeFakeWebContents(false)),
        runner,
        new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
      );
      const out = await executor.execute(claim);
      assert.notEqual(out.status, "succeeded");
      assert.equal(pulled.length, 1, `Must not fallback for ${outcome.kind}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("6. Rejected / unpinned release is never fetched and never triggers fallback", async () => {
  // 6a: Unpinned variant in script_variants (missing release_id / digests)
  const unpinnedClaim = makeVariantClaim({
    script_variants: [
      {
        variant_id: "var-vi",
        priority: 1,
        language_label: "VI",
        package_key: "wp_vi_create_post",
        // missing release_id & digests!
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
  });
  assert.equal(resolveOrderedScriptVariants(unpinnedClaim), null);

  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-6-"));
  try {
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    const { api, calls } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(false)),
      new AuthScriptRunner(),
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(unpinnedClaim);
    assert.equal(out.code, "CONTRACT_GAP_CLAIM_PIN");
    assert.equal(pulled.length, 0, "Unpinned variant must never be pulled");
    assert.equal(calls.length, 0, "Unpinned variant must never ACK");

    // 6b: Pull rejection (CONTENT_DIGEST_MISMATCH) fails immediately without fallback
    const rejectedLoader = new CampaignScriptLoader(undefined, async (claim) => {
      pulled.push({
        package_key: claim.script_id,
        release_id: claim.release_id!,
        job_id: claim.job_id,
        attempt_id: claim.attempt_id,
      });
      return {
        kind: "error",
        code: "CONTENT_DIGEST_MISMATCH",
        message: "content_digest mismatch",
      };
    });
    const exec2 = new CampaignJobExecutor(
      api,
      rejectedLoader,
      makeHost(dir, makeFakeWebContents(false)),
      new AuthScriptRunner(),
      new JobAttemptIdempotencyStore(path.join(dir, "attempts2.json"))
    );
    const out2 = await exec2.execute(makeVariantClaim());
    assert.equal(out2.status, "failed");
    assert.equal(out2.code, "CONTENT_DIGEST_MISMATCH");
    assert.equal(pulled.length, 1, "Rejected release must not fallback to EN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("7. Result delivery retry after process restart delivers without re-running OCR/variants", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-7-"));
  try {
    const storePath = path.join(dir, "attempts.json");
    const claim = makeVariantClaim();
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    let runCalls = 0;
    const runner = {
      run: async (p: { release: { package_key: string } }): Promise<AuthRunOutcome> => {
        runCalls += 1;
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
        return { kind: "ok", stepsExecuted: 2 };
      },
    } as unknown as AuthScriptRunner;

    // First attempt: network error on /result
    const { api: failingApi } = makeApiMock({ failResultOnce: true });
    const exec1 = new CampaignJobExecutor(
      failingApi,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(storePath)
    );
    const out1 = await exec1.execute(claim);
    assert.equal(out1.status, "succeeded");
    assert.equal(out1.reported, false);
    assert.equal(runCalls, 2);

    // Simulated Electron restart: new store + new executor (advance past backoff)
    const restartedStore = new JobAttemptIdempotencyStore(storePath);
    const pendingRec = restartedStore.get(claim.job_id, claim.attempt_id);
    assert.ok(pendingRec);
    pendingRec.nextRetryAt = Date.now() - 1;
    const { api: okApi, calls: retryCalls } = makeApiMock();
    const exec2 = new CampaignJobExecutor(
      okApi,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      restartedStore
    );
    const flushed = await exec2.flushPendingResults();
    assert.equal(flushed, 1);
    assert.equal(runCalls, 2, "Must NEVER re-run OCR or scripts on result delivery retry");
    assert.equal(retryCalls.filter((c) => c.path.endsWith("/result")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("8. Legacy single-script compatibility when script_variants is absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vg-test-8-"));
  try {
    const legacyClaim = parseCampaignJobClaim({
      job_id: "job-legacy-1",
      attempt_id: "att-legacy-1",
      browser_id: "br-1",
      account_id: "acc-1",
      script_id: "wp_legacy_post",
      script_version: "1.0.0",
      release_id: 55,
      content_digest: VI_CONTENT_DIGEST,
      execution_digest: VI_EXEC_DIGEST,
      run_mode: "live",
      execution_mode: "one_account_one_job",
      input: { title: "Legacy Test Title", body: "Legacy Test Body" },
      lease_token: "lease-legacy-1",
      execution_context: { resolved_url: "https://baloquatang.net/wp-admin/post-new.php" },
    })!;
    assert.equal(legacyClaim.script_variants, undefined);
    const pulled: Array<{ package_key: string; release_id: number; job_id: string; attempt_id: string }> = [];
    const runner = {
      run: async (): Promise<AuthRunOutcome> => ({ kind: "ok", stepsExecuted: 2 }),
    } as unknown as AuthScriptRunner;
    const { api } = makeApiMock();
    const executor = new CampaignJobExecutor(
      api,
      makePullLoader(pulled),
      makeHost(dir, makeFakeWebContents(true)),
      runner,
      new JobAttemptIdempotencyStore(path.join(dir, "attempts.json"))
    );
    const out = await executor.execute(legacyClaim);
    assert.equal(out.status, "succeeded");
    assert.equal(out.reported, true);
    assert.equal(pulled.length, 1);
    assert.equal(pulled[0].package_key, "wp_legacy_post");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("9. Three isolated Client instances have distinct userData, attempt stores, and artifact dirs", () => {
  const roots = ["client-A", "client-B", "client-C"].map((id) =>
    resolveDevUserDataPath("D:\\workspace-2026\\rpa-sosial-automation-client", id)
  );
  assert.equal(new Set(roots).size, 3);
  const attemptFiles = roots.map((r) => path.join(r, "campaign-job-attempts.json"));
  const artifactDirs = roots.map((r) => path.join(r, "artifacts", "campaign-jobs"));
  assert.equal(new Set(attemptFiles).size, 3);
  assert.equal(new Set(artifactDirs).size, 3);
});
