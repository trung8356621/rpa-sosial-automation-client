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
import { CampaignScriptLoader, type CampaignScriptPullOutcome } from "../src/main/jobs/campaign-script-loader.js";
import { parseCampaignJobClaim, type CampaignJobClaim, type CampaignScriptPin } from "../src/main/jobs/contracts.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import { OrcBrowserHost } from "../src/main/orc/browser-host.js";
import type { OcrEngine } from "../src/main/orc/ocr.js";
import { VisualOrcExecutor } from "../src/main/orc/visual-executor.js";
import type { ExecutionStatus } from "../src/shared/contracts.js";

const VI_CONTENT_DIGEST = "1".repeat(64);
const VI_EXEC_DIGEST = "2".repeat(64);
const EN_CONTENT_DIGEST = "3".repeat(64);
const EN_EXEC_DIGEST = "4".repeat(64);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makeClaim(overrides: Record<string, unknown> = {}): CampaignJobClaim {
  const parsed = parseCampaignJobClaim({
    plan_version: 2,
    plan_tag_id: 77,
    action_tag_key: "maytuicanvas.create_post",
    site_key: "maytuicanvas.com",
    job_id: "job-reg-1",
    attempt_id: "att-reg-1",
    campaign_id: "camp-reg-1",
    content_id: "cnt-reg-1",
    browser_id: "br-maytuicanvas",
    account_id: "acc-1",
    script_id: "wp_vi_create_post",
    script_version: "4",
    package_key: "wp_vi_create_post",
    release_id: 4,
    content_digest: VI_CONTENT_DIGEST,
    execution_digest: VI_EXEC_DIGEST,
    run_mode: "live",
    execution_mode: "one_account_one_job",
    input: { title: "Regression Title", body: "Regression Body" },
    lease_token: "lease-reg-1",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    execution_context: {
      resolved_url: "https://maytuicanvas.com/wp-admin/post-new.php",
      source: "wp_admin",
    },
    variant_group_id: "vg-1",
    script_variants: [
      {
        variant_id: "var-vi",
        priority: 1,
        language_label: "VI",
        package_key: "wp_vi_create_post",
        release_id: 4,
        script_version: "4",
        content_digest: VI_CONTENT_DIGEST,
        execution_digest: VI_EXEC_DIGEST,
      },
      {
        variant_id: "var-en",
        priority: 2,
        language_label: "EN",
        package_key: "wp_en_create_post",
        release_id: 5,
        script_version: "1",
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
  });
  assert.ok(parsed);
  return parsed;
}

function makeFakeWebContents(opts?: {
  draftVerified?: boolean;
  onDomExec?: (code: string) => void;
}): WebContents {
  const draftVerified = opts?.draftVerified ?? true;
  return {
    isDestroyed: () => false,
    getURL: () => "https://maytuicanvas.com/wp-admin/post.php?post=10&action=edit",
    executeJavaScript: async (code: string) => {
      opts?.onDomExec?.(code);
      if (code.includes("titleMatched") || code.includes("draftStatusHint")) {
        return {
          titleMatched: draftVerified,
          draftStatusHint: draftVerified,
          bodySnippet: draftVerified ? "Draft saved" : "Not found",
        };
      }
      return {};
    },
    executeJavaScriptInIsolatedWorld: async () => ({}),
    capturePage: async () => ({
      toPNG: () => TINY_PNG,
      getSize: () => ({ width: 1024, height: 560 }),
    }),
    setZoomFactor: () => {},
    getZoomFactor: () => 1,
    sendInputEvent: () => {},
    insertText: async () => {},
  } as unknown as WebContents;
}

function makeFakeHost(
  webContents: WebContents,
  statuses: Array<ExecutionStatus | null>
): CampaignJobBrowserHost {
  const account: AccountCredentialSource = {
    accountId: "acc-1",
    siteUrl: "https://maytuicanvas.com",
    username: "admin",
    getPassword: async () => "",
  };
  return {
    open: async () => {},
    navigate: async () => {},
    getWebContents: () => webContents,
    getAuthState: () => null,
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => {},
    restoreViewport: () => {},
    lock: async () => {},
    release: async () => {},
    updateExecutionStatus: (status) => {
      statuses.push(status);
    },
    findProfileForJob: () => ({
      ok: true,
      browserId: "br-maytuicanvas",
      accountId: "acc-1",
      partition: "persist:rpa-client-br-maytuicanvas",
    }),
    loadAccount: async () => account,
  };
}

function makeFakeApi() {
  const results: Array<{ jobId: string; payload: unknown }> = [];
  const api = {
    ack: async () => ({ ok: true, status: 200, errors: [], message: "ok" }),
    progress: async () => ({ ok: true, status: 200, errors: [], message: "ok" }),
    result: async (jobId: string, payload: unknown) => {
      results.push({ jobId, payload });
      return { ok: true, status: 200, errors: [], message: "ok", idempotent: false };
    },
  } as unknown as CampaignJobApi;
  return { api, results };
}

function makeFakeScriptLoader(releasesByPin: Record<string, unknown>) {
  return {
    pullPinnedForPin: async (_claim: CampaignJobClaim, pin: CampaignScriptPin): Promise<CampaignScriptPullOutcome> => {
      const rel = releasesByPin[pin.package_key];
      if (!rel) {
        return { kind: "error", code: "SCRIPT_NOT_FOUND", message: `Missing ${pin.package_key}` };
      }
      return {
        kind: "ok",
        release: rel as never,
        pinned: pin,
        executionContext: { resolvedUrl: "https://maytuicanvas.com/wp-admin/post-new.php", source: "wp_admin" },
      };
    },
    createAssetDownloader: () => async () => TINY_PNG,
  } as unknown as CampaignScriptLoader;
}

test("1. VisualOrcExecutor classifies SCROLL_CONTAINER_CHANGED as blocked without confirmedNotFound", async () => {
  let scrollCalls = 0;
  const fakeWc = {
    isDestroyed: () => false,
    getURL: () => "https://maytuicanvas.com/wp-admin/post-new.php",
    setZoomFactor: () => {},
    getZoomFactor: () => 1,
    debugger: {
      isAttached: () => false,
      attach: () => {},
      sendCommand: async () => ({ data: TINY_PNG.toString("base64") }),
    },
    capturePage: async () => ({
      toPNG: () => TINY_PNG,
      getSize: () => ({ width: 1024, height: 560 }),
    }),
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code ?? "";
      if (code.includes("delete globalThis.__creatorOcrScroll")) return undefined;
      scrollCalls += 1;
      if (scrollCalls === 1) {
        return {
          moved: false,
          reached: false,
          reason: "SCAN_REGION",
          searchRegion: { x: 0, y: 0, width: 1024, height: 560 },
          scrollTop: 0,
          scrollHeight: 1200,
          goal: 400,
        };
      }
      if (scrollCalls === 2) {
        return {
          moved: false,
          reached: false,
          reason: "SCAN_REGION",
          searchRegion: { x: 0, y: 0, width: 1024, height: 560 },
          scrollTop: 0,
          scrollHeight: 1200,
          goal: 400,
        };
      }
      return { blocked: true };
    },
  } as unknown as WebContents;

  const host = new OrcBrowserHost(fakeWc, { x: 0, y: 0, width: 1024, height: 560 });
  const ocr: OcrEngine = {
    recognize: async () => ({ text: "", segments: [], confidence: 0, language: "vie+eng" }),
  };
  const executor = new VisualOrcExecutor(host, ocr);
  const phases: string[] = [];

  const outcome = await executor.executeVisualStep({
    payload: {
      action: "CLICK_AND_TYPE",
      target: {
        asset: "assets/title.png",
        roi: { x: 0, y: 0, width: 1024, height: 560 },
        matchTo: "middle",
        ocr: {
          kind: "line",
          text: "Thêm tiêu đề",
          bbox: { x: 0, y: 0, width: 100, height: 20 },
          confidence: 95,
          confirmed: true,
          language: "vie+eng",
        },
      },
    },
    template: TINY_PNG,
    text: "Hello",
    stepId: "step-0",
    onPhase: (p) => phases.push(p),
  });

  assert.equal(outcome.kind, "blocked");
  if (outcome.kind === "blocked") {
    assert.equal(outcome.code, "SCROLL_CONTAINER_CHANGED");
    assert.equal(outcome.confirmedNotFound, false);
  }
  assert.deepEqual(phases, ["ocr"]);
});

test("2. Step 0 OCR error does not execute subsequent steps and SCROLL_CONTAINER_CHANGED does not trigger fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpa-reg-2-"));
  try {
    let domExecuted = false;
    const wc = makeFakeWebContents({
      onDomExec: (code) => {
        if (code.includes("step-1-dom")) domExecuted = true;
      },
    });
    const statuses: Array<ExecutionStatus | null> = [];
    const host = makeFakeHost(wc, statuses);
    const { api } = makeFakeApi();

    let viStep0Called = false;
    let enStep0Called = false;

    const fakeRunner = {
      run: async (params: {
        release: { package_key: string; manifest: { steps: unknown[] } };
        onProgress?: (ev: { kind: "step_phase"; stepNumber: number; totalSteps: number; phase: "OCR" | "Click" | "Type" } | { kind: "step_failed"; stepNumber: number; totalSteps: number; code: string }) => void;
      }): Promise<AuthRunOutcome> => {
        const total = params.release.manifest.steps.length;
        if (params.release.package_key === "wp_vi_create_post") {
          viStep0Called = true;
          params.onProgress?.({ kind: "step_phase", stepNumber: 1, totalSteps: total, phase: "OCR" });
          params.onProgress?.({
            kind: "step_failed",
            stepNumber: 1,
            totalSteps: total,
            code: "SCROLL_CONTAINER_CHANGED",
          });
          return {
            kind: "error",
            message: "Step 0: SCROLL_CONTAINER_CHANGED: vùng cuộn/modal đã đổi",
            stepsExecuted: 0,
            stepIndex: 0,
            code: "SCROLL_CONTAINER_CHANGED",
            confirmedNotFound: false,
            mutated: false,
          };
        }
        enStep0Called = true;
        return { kind: "ok", stepsExecuted: total };
      },
    } as unknown as AuthScriptRunner;

    const viRelease = {
      package_key: "wp_vi_create_post",
      release_id: 4,
      version: "4",
      manifest: {
        steps: [
          { id: "step-0", action: "click", target: { asset: "a.png" } },
          { id: "step-1", action: "type", selector: "#step-1-dom", value: "body" },
        ],
        variables: [],
        assets: [],
      },
    };
    const enRelease = {
      package_key: "wp_en_create_post",
      release_id: 5,
      version: "1",
      manifest: {
        steps: [
          { id: "step-0", action: "click", target: { asset: "b.png" } },
          { id: "step-1", action: "type", selector: "#step-1-dom", value: "body" },
        ],
        variables: [],
        assets: [],
      },
    };

    const executor = new CampaignJobExecutor(
      api,
      makeFakeScriptLoader({ wp_vi_create_post: viRelease, wp_en_create_post: enRelease }),
      host,
      fakeRunner,
      new JobAttemptIdempotencyStore(path.join(dir, "idemp.json"))
    );

    const out = await executor.execute(makeClaim());
    assert.equal(out.status, "failed");
    assert.equal(out.code, "ORC_ERROR");
    assert.equal(out.stepsExecuted, 0);
    assert.equal(viStep0Called, true);
    assert.equal(enStep0Called, false, "SCROLL_CONTAINER_CHANGED must NOT trigger EN fallback");
    assert.equal(domExecuted, false, "Step 1 must NOT execute after Step 0 fails");

    const nonNullStatuses = statuses.filter((s): s is ExecutionStatus => s !== null);
    assert.deepEqual(
      nonNullStatuses.map((s) => s.text),
      [
        "Step 1/2 — OCR",
        "Step 1/2 — Failed: SCROLL_CONTAINER_CHANGED",
      ]
    );
    assert.equal(statuses.at(-1)?.tone, "failed", "Final failure status must be preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3. Confirmed first-step NOT_FOUND triggers eligible language fallback and emits fallback status updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpa-reg-3-"));
  try {
    const wc = makeFakeWebContents({ draftVerified: true });
    const statuses: Array<ExecutionStatus | null> = [];
    const host = makeFakeHost(wc, statuses);
    const { api } = makeFakeApi();

    const fakeRunner = {
      run: async (params: {
        release: { package_key: string; manifest: { steps: unknown[] } };
        onProgress?: (ev: { kind: "step_phase"; stepNumber: number; totalSteps: number; phase: "OCR" | "Click" | "Type" } | { kind: "step_failed"; stepNumber: number; totalSteps: number; code: string }) => void;
      }): Promise<AuthRunOutcome> => {
        const total = params.release.manifest.steps.length;
        if (params.release.package_key === "wp_vi_create_post") {
          params.onProgress?.({ kind: "step_phase", stepNumber: 1, totalSteps: total, phase: "OCR" });
          params.onProgress?.({ kind: "step_failed", stepNumber: 1, totalSteps: total, code: "NOT_FOUND" });
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
        params.onProgress?.({ kind: "step_phase", stepNumber: 1, totalSteps: total, phase: "OCR" });
        params.onProgress?.({ kind: "step_phase", stepNumber: 1, totalSteps: total, phase: "Click" });
        params.onProgress?.({ kind: "step_phase", stepNumber: 2, totalSteps: total, phase: "Type" });
        return { kind: "ok", stepsExecuted: total };
      },
    } as unknown as AuthScriptRunner;

    const viRelease = {
      package_key: "wp_vi_create_post",
      release_id: 4,
      version: "4",
      manifest: {
        steps: [
          { id: "v0", action: "click" },
          { id: "v1", action: "type" },
          { id: "v2", action: "click" },
          { id: "v3", action: "click" },
        ],
        variables: [],
        assets: [],
      },
    };
    const enRelease = {
      package_key: "wp_en_create_post",
      release_id: 5,
      version: "1",
      manifest: {
        steps: [
          { id: "e0", action: "click" },
          { id: "e1", action: "type" },
          { id: "e2", action: "click" },
          { id: "e3", action: "click" },
        ],
        variables: [],
        assets: [],
      },
    };

    const executor = new CampaignJobExecutor(
      api,
      makeFakeScriptLoader({ wp_vi_create_post: viRelease, wp_en_create_post: enRelease }),
      host,
      fakeRunner,
      new JobAttemptIdempotencyStore(path.join(dir, "idemp.json"))
    );

    const out = await executor.execute(makeClaim());
    assert.equal(out.status, "succeeded");
    assert.equal(out.selectedVariant?.language_label, "EN");

    const texts = statuses.filter((s): s is ExecutionStatus => s !== null).map((s) => s.text);
    assert.deepEqual(texts, [
      "Step 1/4 — OCR",
      "Step 1/4 — Failed: NOT_FOUND",
      "Fallback VI → EN — Step 1/4",
      "EN · Step 1/4 — OCR",
      "EN · Step 1/4 — Click",
      "EN · Step 2/4 — Type",
    ]);
    assert.equal(statuses.at(-1), null, "Status cleared after job succeeds");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("4. Missing or unpinned EN variant does not trigger fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpa-reg-4-"));
  try {
    const wc = makeFakeWebContents();
    const statuses: Array<ExecutionStatus | null> = [];
    const host = makeFakeHost(wc, statuses);
    const { api } = makeFakeApi();

    let runCount = 0;
    const fakeRunner = {
      run: async (): Promise<AuthRunOutcome> => {
        runCount += 1;
        return {
          kind: "error",
          message: "Step 0: NOT_FOUND",
          stepsExecuted: 0,
          stepIndex: 0,
          code: "NOT_FOUND",
          confirmedNotFound: true,
          mutated: false,
        };
      },
    } as unknown as AuthScriptRunner;

    const viRelease = {
      package_key: "wp_vi_create_post",
      release_id: 4,
      version: "4",
      manifest: { steps: [{ id: "v0", action: "click" }], variables: [], assets: [] },
    };

    const executor = new CampaignJobExecutor(
      api,
      makeFakeScriptLoader({ wp_vi_create_post: viRelease }),
      host,
      fakeRunner,
      new JobAttemptIdempotencyStore(path.join(dir, "idemp.json"))
    );

    // 4a: Missing EN variant (only VI in script_variants)
    const missingEnClaim = makeClaim({
      job_id: "job-reg-4a",
      attempt_id: "att-reg-4a",
      script_variants: [
        {
          variant_id: "var-vi",
          priority: 1,
          language_label: "VI",
          package_key: "wp_vi_create_post",
          release_id: 4,
          script_version: "4",
          content_digest: VI_CONTENT_DIGEST,
          execution_digest: VI_EXEC_DIGEST,
        },
      ],
    });
    const outMissing = await executor.execute(missingEnClaim);
    assert.equal(outMissing.status, "failed");
    assert.equal(runCount, 1);

    // 4b: Unpinned EN variant (missing execution_digest) -> rejected before ACK/run
    const unpinnedEnClaim = makeClaim({
      job_id: "job-reg-4b",
      attempt_id: "att-reg-4b",
      script_variants: [
        {
          variant_id: "var-vi",
          priority: 1,
          language_label: "VI",
          package_key: "wp_vi_create_post",
          release_id: 4,
          script_version: "4",
          content_digest: VI_CONTENT_DIGEST,
          execution_digest: VI_EXEC_DIGEST,
        },
        {
          variant_id: "var-en",
          priority: 2,
          language_label: "EN",
          package_key: "wp_en_create_post",
          release_id: 5,
          script_version: "1",
          content_digest: EN_CONTENT_DIGEST,
        },
      ],
    });
    const outUnpinned = await executor.execute(unpinnedEnClaim);
    assert.equal(outUnpinned.status, "failed");
    assert.equal(outUnpinned.code, "CONTRACT_GAP_CLAIM_PIN");
    assert.equal(runCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("5. Real AuthScriptRunner does not advance past Step 0 when Step 0 fails and emits 1-based step status", async () => {
  const step1Executed: boolean[] = [];
  const wc = makeFakeWebContents({
    onDomExec: (code) => {
      if (code.includes("#missing-step-0")) {
        throw new Error("DOM element #missing-step-0 not found");
      }
      if (code.includes("#step-1-target")) {
        step1Executed.push(true);
      }
    },
  });
  const runner = new AuthScriptRunner();
  const events: unknown[] = [];

  const out = await runner.run({
    webContents: wc,
    release: {
      package_key: "wp_vi_create_post",
      release_id: 4,
      version: "4",
      manifest: {
        steps: [
          { id: "s0", action: "click", selector: "#missing-step-0" },
          { id: "s1", action: "click", selector: "#step-1-target" },
        ],
        variables: [],
        assets: [],
      },
    } as never,
    account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" },
    timeoutMs: 1000,
    onProgress: (ev) => events.push(ev),
  });

  assert.equal(out.kind, "error");
  assert.equal(out.stepsExecuted, 0);
  assert.equal(step1Executed.length, 0, "Step 1 must never execute when Step 0 fails");
  assert.deepEqual(events, [{ kind: "step_phase", stepNumber: 1, totalSteps: 2, phase: "DOM" }]);
});
