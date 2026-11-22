import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import {
  CampaignJobExecutor,
  type CampaignJobBrowserHost,
} from "../src/main/jobs/campaign-job-executor.js";
import { CampaignJobWorker } from "../src/main/jobs/campaign-job-worker.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import {
  doesSiteKeyMatchSiteUrl,
  parseCampaignJobClaim,
  resolveClaimScriptPin,
  type CampaignJobClaim,
} from "../src/main/jobs/contracts.js";
import { resolveJobVariableBindings } from "../src/main/jobs/job-input-bindings.js";
import {
  acquireInstanceLock,
  resolveDevUserDataPath,
} from "../src/main/dev-instance.js";

const CONTENT_DIGEST = "a".repeat(64);
const EXEC_DIGEST = "b".repeat(64);

function makeV2RawClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_version: 2,
    plan_tag_id: 42,
    action_tag_key: "maytuicanvas.create_post",
    site_key: "maytuicanvas.com",
    job_id: "job-v2-001",
    attempt_id: "att-v2-001",
    campaign_id: "camp-v2-001",
    content_id: "content-v2-001",
    browser_id: "browser-1",
    account_id: "account-1",
    lease_token: "lease-v2-xyz",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    package_key: "pkg-create-post",
    package_id: 101,
    release_id: 55,
    version: "2.0.1",
    script_id: "pkg-create-post",
    script_version: "2.0.1",
    content_digest: CONTENT_DIGEST,
    execution_digest: EXEC_DIGEST,
    input: {
      title: "Campaign V2 Draft Title",
      content: "<p>Hello V2</p>",
    },
    run_mode: "test",
    execution_mode: "one_account_one_job",
    ...overrides,
  };
}

function makePullRelease(overrides: Record<string, unknown> = {}) {
  return {
    action_tag_id: 42,
    action_tag_key: "maytuicanvas.create_post",
    package_key: "pkg-create-post",
    package_id: 101,
    kind: "script",
    is_authentication: false,
    version: "2.0.1",
    release_id: 55,
    content_digest: CONTENT_DIGEST,
    execution_digest: EXEC_DIGEST,
    schema_version: 2,
    status: "published",
    runtime_compatibility: { min_client_version: "0.1.0" },
    assets_complete: true,
    ready_to_execute: true,
    manifest: {
      variables: [
        { key: "title", type: "string" },
        { key: "content", type: "string" },
      ],
      assets: [],
      steps: [{ action: "WAIT", ms: 10 }],
    },
    ...overrides,
  };
}

function makeFakeWebContents(draftTitle = "Campaign V2 Draft Title") {
  return {
    isDestroyed: () => false,
    getURL: () => "https://maytuicanvas.com/wp-admin/post.php?post=123&action=edit",
    executeJavaScript: async () => ({
      titleMatched: true,
      draftStatusHint: true,
      bodySnippet: draftTitle,
    }),
  } as never;
}

test("1. Valid Campaign V2 claim payload parses all V2 fields and pin", () => {
  const claim = parseCampaignJobClaim(makeV2RawClaim());
  assert.ok(claim);
  assert.equal(claim.plan_version, 2);
  assert.equal(claim.plan_tag_id, 42);
  assert.equal(claim.action_tag_key, "maytuicanvas.create_post");
  assert.equal(claim.site_key, "maytuicanvas.com");
  assert.equal(claim.package_key, "pkg-create-post");
  assert.equal(claim.package_id, 101);
  assert.equal(claim.version, "2.0.1");
  assert.equal(claim.script_id, "pkg-create-post");
  assert.equal(claim.script_version, "2.0.1");

  const pin = resolveClaimScriptPin(claim);
  assert.ok(pin);
  assert.equal(pin.package_key, "pkg-create-post");
  assert.equal(pin.version, "2.0.1");
  assert.equal(pin.release_id, 55);
  assert.equal(pin.content_digest, CONTENT_DIGEST);
  assert.equal(pin.execution_digest, EXEC_DIGEST);
});

test("2. Wrong Site / Account / Browser / Package identity is rejected fail-closed", async () => {
  assert.equal(doesSiteKeyMatchSiteUrl("maytuicanvas.com", "https://maytuicanvas.com/"), true);
  assert.equal(doesSiteKeyMatchSiteUrl("maytuicanvas.com", "https://www.maytuicanvas.com/wp-admin"), true);
  assert.equal(doesSiteKeyMatchSiteUrl("maytuicanvas.com", "https://baloquatang.com/"), false);

  // Conflicting script_id vs package_key rejected at parse
  assert.equal(
    parseCampaignJobClaim(makeV2RawClaim({ script_id: "pkg-a", package_key: "pkg-b" })),
    null
  );

  const claim = parseCampaignJobClaim(makeV2RawClaim({ site_key: "maytuicanvas.com" }))!;
  const resultCalls: Array<Record<string, unknown>> = [];
  let ackCount = 0;
  const api = {
    ack: async () => {
      ackCount += 1;
      return { ok: true, data: null };
    },
    progress: async () => ({ ok: true, data: null }),
    result: async (_jobId: string, body: Record<string, unknown>) => {
      resultCalls.push(body);
      return { ok: true, data: null };
    },
  } as unknown as CampaignJobApi;

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePullRelease() as never,
    pinned: resolveClaimScriptPin(claim)!,
  }));

  // Case A: local profile binding site mismatch rejects before ACK
  const hostPreAck: CampaignJobBrowserHost = {
    open: async () => undefined,
    getWebContents: () => makeFakeWebContents(),
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: false,
      message: "Site mismatch: claim site_key=maytuicanvas.com ≠ profile siteUrl=https://baloquatang.com/",
    }),
    loadAccount: async () => {
      throw new Error("should not load account");
    },
  };
  const preAckOut = await new CampaignJobExecutor(api, loader, hostPreAck).execute(claim);
  assert.equal(preAckOut.status, "failed");
  assert.equal(preAckOut.code, "ACCOUNT_BROWSER_MISMATCH");
  assert.equal(ackCount, 0);

  // Case B: server account siteUrl mismatch rejects after ACK with SITE_MISMATCH before running script
  const hostPostAck: CampaignJobBrowserHost = {
    ...hostPreAck,
    findProfileForJob: () => ({
      ok: true,
      browserId: "browser-1",
      accountId: "account-1",
      partition: "persist:rpa-client-browser-1",
    }),
    loadAccount: async () => ({
      accountId: "account-1",
      username: "admin",
      email: "admin@baloquatang.com",
      siteUrl: "https://baloquatang.com/",
      getPassword: async () => "secret",
    }),
  };

  const executor = new CampaignJobExecutor(api, loader, hostPostAck);
  const out = await executor.execute(claim);
  assert.equal(out.status, "failed");
  assert.equal(out.code, "SITE_MISMATCH");
  assert.equal(resultCalls.length, 2);
  assert.equal(resultCalls[1].attempt_id, claim.attempt_id);
  assert.equal(resultCalls[1].lease_token, claim.lease_token);
});

test("3. Pinned Release validation rejects digest or release_id mismatch", async () => {
  const claim = parseCampaignJobClaim(makeV2RawClaim())!;
  const connection = {
    isOnline: () => true,
    getConnectionToken: () => "conn-tok",
    requestWithAuth: async () => ({
      ok: true,
      release: makePullRelease({ execution_digest: "f".repeat(64) }),
    }),
  };
  const loader = new CampaignScriptLoader(connection as never);
  const pulled = await loader.pullPinned(claim);
  assert.equal(pulled.kind, "error");
  if (pulled.kind === "error") {
    assert.equal(pulled.code, "EXECUTION_DIGEST_MISMATCH");
  }
});

test("4. Script input propagation merges V2 claim.input with Account credentials", async () => {
  const bindings = await resolveJobVariableBindings({
    variables: [
      { key: "title", type: "string" },
      { key: "content", type: "string" },
      { key: "username", type: "string" },
    ],
    jobInput: {
      title: "My V2 Article",
      content: "Body HTML",
      extra_tag: "seo",
    },
    account: {
      accountId: "account-1",
      username: "wp-author",
      email: "author@maytuicanvas.com",
      siteUrl: "https://maytuicanvas.com/",
      getPassword: async () => "pw",
    },
  });
  assert.equal(bindings.ok, true);
  if (bindings.ok) {
    assert.equal(bindings.values.title, "My V2 Article");
    assert.equal(bindings.values.content, "Body HTML");
    assert.equal(bindings.values.username, "wp-author");
    assert.equal(bindings.values.extra_tag, "seo");
  }
});

test("5. ACK / progress / result retain original attempt_id and lease_token", async () => {
  const claim = parseCampaignJobClaim(makeV2RawClaim())!;
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];

  const api = {
    ack: async (_jobId: string, body: Record<string, unknown>) => {
      calls.push({ endpoint: "ack", body });
      return { ok: true, data: null };
    },
    progress: async (_jobId: string, body: Record<string, unknown>) => {
      calls.push({ endpoint: "progress", body });
      return { ok: true, data: null };
    },
    result: async (_jobId: string, body: Record<string, unknown>) => {
      calls.push({ endpoint: "result", body });
      return { ok: true, data: null };
    },
  } as unknown as CampaignJobApi;

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePullRelease() as never,
    pinned: resolveClaimScriptPin(claim)!,
  }));

  const host: CampaignJobBrowserHost = {
    open: async () => undefined,
    getWebContents: () => makeFakeWebContents(),
    getAuthState: () => ({
      code: "SESSION_VALID",
      checkpointStatus: "present",
      message: "Session valid",
    }),
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true,
      browserId: "browser-1",
      accountId: "account-1",
      partition: "persist:rpa-client-browser-1",
    }),
    loadAccount: async () => ({
      accountId: "account-1",
      username: "admin",
      email: "admin@maytuicanvas.com",
      siteUrl: "https://maytuicanvas.com/",
      getPassword: async () => "secret",
    }),
  };

  const runner = {
    run: async () => ({ kind: "ok" as const, stepsExecuted: 1 }),
  };

  const executor = new CampaignJobExecutor(api, loader, host, runner as never);
  const out = await executor.execute(claim);
  assert.equal(out.status, "succeeded");
  assert.equal(out.draftVerified, true);

  const ackCall = calls.find((c) => c.endpoint === "ack");
  const resultCall = calls.find((c) => c.endpoint === "result");
  assert.ok(ackCall);
  assert.ok(resultCall);
  assert.equal(ackCall!.body.attempt_id, claim.attempt_id);
  assert.equal(ackCall!.body.lease_token, claim.lease_token);
  assert.equal(resultCall!.body.attempt_id, claim.attempt_id);
  assert.equal(resultCall!.body.lease_token, claim.lease_token);
});

test("6 & 8. Duplicate claim prevention and Unknown outcome (HUMAN_REQUIRED) never auto-retry", async () => {
  const claim = parseCampaignJobClaim(makeV2RawClaim())!;
  const resultCalls: Array<Record<string, unknown>> = [];
  let runnerRuns = 0;

  const api = {
    ack: async () => ({ ok: true, data: null }),
    progress: async () => ({ ok: true, data: null }),
    result: async (_jobId: string, body: Record<string, unknown>) => {
      resultCalls.push(body);
      return { ok: true, data: null };
    },
  } as unknown as CampaignJobApi;

  const loader = new CampaignScriptLoader(undefined, async () => ({
    kind: "ok",
    release: makePullRelease() as never,
    pinned: resolveClaimScriptPin(claim)!,
  }));

  const host: CampaignJobBrowserHost = {
    open: async () => undefined,
    getWebContents: () => makeFakeWebContents(),
    getAuthState: () => ({
      code: "HUMAN_REQUIRED",
      checkpointStatus: "absent",
      message: "2FA required",
    }),
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true,
      browserId: "browser-1",
      accountId: "account-1",
      partition: "persist:rpa-client-browser-1",
    }),
    loadAccount: async () => ({
      accountId: "account-1",
      username: "admin",
      email: "admin@maytuicanvas.com",
      siteUrl: "https://maytuicanvas.com/",
      getPassword: async () => "secret",
    }),
  };

  const runner = {
    run: async () => {
      runnerRuns += 1;
      return { kind: "ok" as const, stepsExecuted: 1 };
    },
  };

  const executor = new CampaignJobExecutor(api, loader, host, runner as never);
  const first = await executor.execute(claim);
  assert.equal(first.status, "unknown");
  assert.equal(first.code, "HUMAN_REQUIRED");
  assert.equal(runnerRuns, 0, "must not run action script when auth needs human");
  assert.equal(resultCalls.length, 1);
  assert.equal(resultCalls[0].status, "unknown");

  // Duplicate delivery of same (job_id, attempt_id) is skipped idempotently
  const second = await executor.execute(claim);
  assert.equal(second.idempotentSkip, true);
  assert.equal(second.status, "unknown");
  assert.equal(resultCalls.length, 1);
});

test("7. Multiple isolated Electron instances have distinct userData and exclusive locks", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-v2-iso-"));
  try {
    const dirA = resolveDevUserDataPath(tmpRoot, "client-A");
    const dirB = resolveDevUserDataPath(tmpRoot, "client-B");
    const dirC = resolveDevUserDataPath(tmpRoot, "client-C");
    assert.equal(new Set([dirA, dirB, dirC]).size, 3);

    const lockA = acquireInstanceLock(dirA);
    const lockB = acquireInstanceLock(dirB);
    const lockC = acquireInstanceLock(dirC);
    assert.throws(() => acquireInstanceLock(dirA));
    lockA.release();
    lockB.release();
    lockC.release();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("9, 10, 11. Default-OFF gate, V1 backward compatibility, and React-Web-independent main-process polling", async () => {
  // V1 claim without V2 fields
  const v1Claim = parseCampaignJobClaim({
    job_id: "job-v1-1",
    attempt_id: "att-v1-1",
    campaign_id: "camp-v1",
    content_id: "content-v1",
    browser_id: "b1",
    account_id: "a1",
    script_id: "pkg-v1",
    script_version: "1",
    run_mode: "live",
    execution_mode: "one_account_one_job",
    input: { title: "V1 Title" },
    lease_token: "lease-v1",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    release_id: 1,
    content_digest: CONTENT_DIGEST,
    execution_digest: EXEC_DIGEST,
  });
  assert.ok(v1Claim);
  assert.equal(v1Claim.plan_version, undefined);
  assert.ok(resolveClaimScriptPin(v1Claim));

  // Worker lifecycle driven purely by ClientConnection (no renderer / Socket.IO)
  let onStateChangeCb: ((state: { status: string; online: boolean }) => void) | null = null;
  let online = false;
  let claimCalls = 0;
  let cancelCalls = 0;

  const connection = {
    isOnline: () => online,
    getState: () => ({
      status: online ? "connected" : "disconnected",
      online,
      agentUuid: "agent-main",
      endpoint: "https://example.test",
      hasKey: true,
    }),
    getConnectionToken: () => "tok",
    requestWithAuth: async () => ({ ok: true, data: null }),
    onStateChange: (cb: (state: { status: string; online: boolean }) => void) => {
      onStateChangeCb = cb;
      return () => undefined;
    },
  };

  const worker = new CampaignJobWorker(
    connection as never,
    { list: () => [{ browserId: "b1", accountBinding: { accountId: "a1" } }] } as never,
    {
      claim: async () => {
        claimCalls += 1;
        return { ok: true, data: null };
      },
    } as never,
    {
      cancelActive: () => {
        cancelCalls += 1;
      },
      execute: async () => {
        throw new Error("unused");
      },
    } as never,
    new CampaignScriptLoader(connection as never)
  );

  // Default OFF even when connected
  online = true;
  onStateChangeCb!({ status: "connected", online: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(claimCalls, 0, "default-OFF gate blocks claim even when online");

  // Enable runtime gate & trigger tick
  worker.setEnabled(true);
  await worker.tick("manual");
  assert.equal(claimCalls, 1);

  // Going offline stops polling and cancels active job
  online = false;
  onStateChangeCb!({ status: "disconnected", online: false });
  assert.equal(cancelCalls, 1);

  worker.destroy();
});
