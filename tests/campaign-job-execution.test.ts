import assert from "node:assert/strict";
import test from "node:test";
import { CampaignJobApi } from "../src/main/jobs/campaign-job-api.js";
import {
  CAMPAIGN_SCRIPT_APIS_AVAILABLE,
  parseCampaignJobClaim,
  resolveClaimScriptPin,
  type CampaignJobClaim,
} from "../src/main/jobs/contracts.js";
import {
  CampaignScriptLoader,
  parseCampaignActionRelease,
} from "../src/main/jobs/campaign-script-loader.js";
import { CampaignJobExecutor } from "../src/main/jobs/campaign-job-executor.js";
import { JobAttemptIdempotencyStore } from "../src/main/jobs/idempotency.js";
import {
  flattenJobInput,
  requireTitleBinding,
  resolveJobVariableBindings,
} from "../src/main/jobs/job-input-bindings.js";
import { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function sampleClaim(over: Partial<CampaignJobClaim> = {}): CampaignJobClaim {
  return {
    job_id: "11111111-1111-1111-1111-111111111111",
    attempt_id: "22222222-2222-2222-2222-222222222222",
    campaign_id: "camp-1",
    content_id: "content-1",
    browser_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    script_id: "00c6ca04-0000-0000-0000-000000000001",
    script_version: "1",
    run_mode: "test",
    execution_mode: "one_account_one_job",
    input: { title: "CP19 Draft Title" },
    lease_token: "lease-token-opaque",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    release_id: 1,
    content_digest: CONTENT,
    execution_digest: EXEC,
    ...over,
  };
}

function sampleRelease(over: Record<string, unknown> = {}) {
  return {
    action_tag_id: 0,
    action_tag_key: "mayhopphat.create_post",
    package_key: "00c6ca04-0000-0000-0000-000000000001",
    package_id: 9,
    kind: "script",
    is_authentication: false,
    version: "1",
    release_id: 1,
    content_digest: CONTENT,
    execution_digest: EXEC,
    schema_version: 1,
    status: "published",
    runtime_compatibility: null,
    assets_complete: true,
    ready_to_execute: true,
    manifest: {
      variables: [{ key: "title", type: "string" }],
      assets: [
        { path: "roi/title.png", sha256: "c".repeat(64) },
        { path: "roi/save.png", sha256: "d".repeat(64) },
      ],
      steps: [
        {
          action: "CLICK_AND_TYPE",
          variable_key: "title",
          target: {
            asset: "roi/title.png",
            roi: { x: 10, y: 10, width: 100, height: 40 },
          },
        },
        {
          action: "CLICK_TARGET",
          target: {
            asset: "roi/save.png",
            roi: { x: 20, y: 20, width: 80, height: 30 },
          },
        },
      ],
    },
    ...over,
  };
}

test("Action Script APIs marked available (live deploy)", () => {
  assert.equal(CAMPAIGN_SCRIPT_APIS_AVAILABLE, true);
});

test("parseCampaignJobClaim + exact pin requires both digests and release_id", () => {
  const ok = parseCampaignJobClaim(sampleClaim());
  assert.ok(ok);
  const pin = resolveClaimScriptPin(ok!);
  assert.ok(pin);
  assert.equal(pin!.content_digest, CONTENT);
  assert.equal(pin!.execution_digest, EXEC);
  assert.equal(pin!.release_id, 1);

  assert.equal(
    resolveClaimScriptPin(sampleClaim({ execution_digest: undefined })),
    null
  );
  assert.equal(resolveClaimScriptPin(sampleClaim({ release_id: undefined })), null);
});

test("parseCampaignActionRelease keeps content_digest and execution_digest distinct", () => {
  const release = parseCampaignActionRelease(sampleRelease());
  assert.ok(release);
  assert.equal(release!.content_digest, CONTENT);
  assert.equal(release!.execution_digest, EXEC);
  assert.notEqual(release!.content_digest, release!.execution_digest);

  assert.equal(
    parseCampaignActionRelease(sampleRelease({ execution_digest: undefined })),
    null
  );
});

test("loader pull posts fence + pin fields to /client/scripts/pull (never auth)", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const connection = {
    isOnline: () => true,
    getConnectionToken: () => "conn-token",
    requestWithAuth: async (path: string, _m: string, body?: Record<string, unknown>) => {
      calls.push({ path, body: body || {} });
      assert.doesNotMatch(path, /\/client\/auth\//);
      return { ok: true, release: sampleRelease() };
    },
  };
  const loader = new CampaignScriptLoader(connection as never);
  assert.equal(loader.readiness(), null);
  const out = await loader.pullPinned(sampleClaim());
  assert.equal(out.kind, "ok");
  assert.equal(calls[0].path, "/api/v1/social-automation/client/scripts/pull");
  assert.equal(calls[0].body.connection_token, "conn-token");
  assert.equal(calls[0].body.job_id, sampleClaim().job_id);
  assert.equal(calls[0].body.attempt_id, sampleClaim().attempt_id);
  assert.equal(calls[0].body.lease_token, "lease-token-opaque");
  assert.equal(calls[0].body.account_id, sampleClaim().account_id);
  assert.equal(calls[0].body.package_key, sampleClaim().script_id);
  assert.equal(calls[0].body.version, "1");
  assert.equal(calls[0].body.release_id, 1);
});

test("loader rejects swapped digests (content vs execution)", async () => {
  const connection = {
    isOnline: () => true,
    getConnectionToken: () => "t",
    requestWithAuth: async () => ({
      ok: true,
      // Swap digests relative to claim pin
      release: sampleRelease({
        content_digest: EXEC,
        execution_digest: CONTENT,
      }),
    }),
  };
  const loader = new CampaignScriptLoader(connection as never);
  const out = await loader.pullPinned(sampleClaim());
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.equal(out.code, "CONTENT_DIGEST_MISMATCH");
  }
});

test("asset downloader uses /client/scripts/asset with job fence", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const connection = {
    isOnline: () => true,
    getConnectionToken: () => "conn-token",
    requestWithAuth: async (path: string, _m: string, body?: Record<string, unknown>) => {
      calls.push({ path, body: body || {} });
      return { ok: true, asset_base64: Buffer.from("roi").toString("base64"), sha256: "c".repeat(64) };
    },
  };
  const loader = new CampaignScriptLoader(connection as never);
  const dl = loader.createAssetDownloader(sampleClaim());
  const res = await dl({
    accountId: sampleClaim().account_id,
    packageKey: sampleClaim().script_id,
    version: "1",
    releaseId: 1,
    assetPath: "roi/title.png",
    expectedSha256: "c".repeat(64),
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/social-automation/client/scripts/asset");
  assert.equal(calls[0].body.lease_token, "lease-token-opaque");
  assert.equal(calls[0].body.job_id, sampleClaim().job_id);
  assert.equal(calls[0].body.asset_path, "roi/title.png");
  assert.doesNotMatch(calls[0].path, /auth/);
});

test("job input binds title variable for mayhopphat.create_post", async () => {
  const flat = flattenJobInput({ title: "Hello Draft", n: 1 });
  assert.equal(flat.title, "Hello Draft");
  const bound = await resolveJobVariableBindings({
    variables: [{ key: "title" }, { key: "username" }],
    jobInput: { title: "From Job" },
    account: {
      accountId: "a1",
      username: "editor",
      email: null,
      siteUrl: "https://mayhopphat.com",
      getPassword: async () => "",
    },
  });
  assert.equal(bound.ok, true);
  if (bound.ok) {
    assert.equal(bound.values.title, "From Job");
    assert.equal(bound.values.username, "editor");
  }
  const title = requireTitleBinding(bound.ok ? bound.values : {}, [{ key: "title" }]);
  assert.equal(title.ok, true);
});

test("CampaignJobApi claim/ack/progress/result follow OpenAPI paths + fence body", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const connection = {
    isOnline: () => true,
    requestWithAuth: async (path: string, _method: string, body?: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path.endsWith("/claim")) return { ok: true, data: sampleClaim() };
      return { ok: true, data: null, idempotent: path.includes("/result") };
    },
  };
  const api = new CampaignJobApi(connection as never);
  const claimed = await api.claim({
    agentUuid: "agent-1",
    browserIds: ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok || !claimed.data) throw new Error("expected claim");
  assert.ok(resolveClaimScriptPin(claimed.data));

  await api.ack(claimed.data.job_id, {
    attempt_id: claimed.data.attempt_id,
    lease_token: claimed.data.lease_token,
  });
  await api.result(claimed.data.job_id, {
    attempt_id: claimed.data.attempt_id,
    lease_token: claimed.data.lease_token,
    status: "succeeded",
    output: {},
    error: null,
  });
  assert.equal(calls[0].path, "/api/v1/social-automation/client/jobs/claim");
  assert.match(calls[1].path, /\/ack$/);
  assert.match(calls[2].path, /\/result$/);
});

test("executor without claim pin does not ACK", async () => {
  const apiCalls: string[] = [];
  const api = {
    ack: async () => {
      apiCalls.push("ack");
      return { ok: true, data: null };
    },
    progress: async () => ({ ok: true, data: null }),
    result: async () => {
      apiCalls.push("result");
      return { ok: true, data: null };
    },
    claim: async () => ({ ok: true, data: null }),
  };
  const host = {
    open: async () => undefined,
    getWebContents: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true as const,
      browserId: "b1",
      accountId: "a1",
      partition: "persist:rpa-client-b1",
    }),
    loadAccount: async () => ({
      accountId: "a1",
      username: "u",
      email: null,
      siteUrl: null,
      getPassword: async () => "",
    }),
  };
  const loader = new CampaignScriptLoader({
    isOnline: () => true,
    getConnectionToken: () => "t",
    requestWithAuth: async () => ({ ok: true, release: sampleRelease() }),
  } as never);
  const executor = new CampaignJobExecutor(api as never, loader, host as never);
  const out = await executor.execute(sampleClaim({ execution_digest: undefined }));
  assert.equal(out.code, "CONTRACT_GAP_CLAIM_PIN");
  assert.equal(out.reported, false);
  assert.deepEqual(apiCalls, []);
});

test("idempotency store prevents re-execution of same attempt", async () => {
  const store = new JobAttemptIdempotencyStore();
  store.markTerminal("j1", "a1", "succeeded");
  let ran = 0;
  const api = {
    ack: async () => ({ ok: true, data: null }),
    progress: async () => ({ ok: true, data: null }),
    result: async () => ({ ok: true, data: null }),
    claim: async () => ({ ok: true, data: null }),
  };
  const loader = new CampaignScriptLoader(undefined, async () => {
    ran += 1;
    return {
      kind: "ok",
      release: parseCampaignActionRelease(sampleRelease())!,
      pinned: resolveClaimScriptPin(sampleClaim())!,
    };
  });
  const host = {
    open: async () => {
      ran += 1;
    },
    getWebContents: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true as const,
      browserId: "b",
      accountId: "a",
      partition: "p",
    }),
    loadAccount: async () => ({ accountId: "a", getPassword: async () => "" }),
  };
  const executor = new CampaignJobExecutor(
    api as never,
    loader,
    host as never,
    new AuthScriptRunner(),
    store
  );
  const out = await executor.execute(sampleClaim({ job_id: "j1", attempt_id: "a1" }));
  assert.equal(out.idempotentSkip, true);
  assert.equal(ran, 0);
});

test("executor ACK then fail closed without fake draft success", async () => {
  const results: Array<Record<string, unknown>> = [];
  const api = {
    ack: async () => ({ ok: true, data: null }),
    progress: async () => ({ ok: true, data: null }),
    result: async (_id: string, body: Record<string, unknown>) => {
      results.push(body);
      return { ok: true, data: null, idempotent: false };
    },
    claim: async () => ({ ok: true, data: null }),
  };
  const fakeWc = {
    isDestroyed: () => false,
    getURL: () => "https://mayhopphat.com/wp-admin/post-new.php",
    executeJavaScript: async () => ({
      titleMatched: false,
      draftStatusHint: true,
      bodySnippet: "no title",
    }),
  };
  const host = {
    open: async () => undefined,
    getWebContents: () => fakeWc,
    getBounds: () => ({ x: 0, y: 0, width: 1024, height: 560 }),
    applyViewport: () => undefined,
    restoreViewport: () => undefined,
    lock: async () => undefined,
    release: async () => undefined,
    findProfileForJob: () => ({
      ok: true as const,
      browserId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      partition: "persist:rpa-client-bbbb",
    }),
    loadAccount: async () => ({
      accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "editor",
      email: null,
      siteUrl: "https://mayhopphat.com",
      getPassword: async () => "x",
    }),
  };
  const runner = { run: async () => ({ kind: "ok" as const, stepsExecuted: 2 }) };
  const loader = new CampaignScriptLoader(undefined, async (claim) => ({
    kind: "ok",
    release: parseCampaignActionRelease(
      sampleRelease({
        package_key: claim.script_id,
        version: claim.script_version,
        content_digest: CONTENT,
        execution_digest: EXEC,
      })
    )!,
    pinned: resolveClaimScriptPin(claim)!,
  }));
  const executor = new CampaignJobExecutor(
    api as never,
    loader,
    host as never,
    runner as never
  );
  const out = await executor.execute(sampleClaim());
  assert.equal(out.status, "failed");
  assert.equal(out.code, "DRAFT_NOT_VERIFIED");
  assert.equal(out.reported, true);
  assert.equal(results[0]?.status, "failed");
  assert.notEqual(results[0]?.status, "succeeded");
});
