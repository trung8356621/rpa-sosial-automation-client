import assert from "node:assert/strict";
import test from "node:test";
import { AuthContextFinder, parseAuthContextResponse } from "../src/main/auth/auth-context-finder.js";
import { AuthScriptResolver } from "../src/main/auth/auth-script-resolver.js";
import { AuthScriptLoader } from "../src/main/auth/auth-script-loader.js";
import { BrowserOpenOrchestrator, type AuthRunnerLike } from "../src/main/auth/browser-open-orchestrator.js";
import { formatAuthStatusDisplay } from "../src/shared/auth-status.js";

const DIGEST = "a".repeat(64);

function makeRelease(actionTagId: number, actionTagKey: string) {
  return {
    action_tag_id: actionTagId,
    action_tag_key: actionTagKey,
    package_key: "pkg-cms-auth",
    package_id: 10,
    kind: "script",
    is_authentication: true,
    version: "1.0.0",
    release_id: 42,
    content_digest: DIGEST,
    schema_version: 1,
    status: "published",
    assets_complete: true,
    ready_to_execute: true,
    manifest: { steps: [{ action: "navigate", url: "https://site.test/wp-login.php" }] },
  };
}

function makeConnection(handler: (subpath: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return {
    isOnline: () => true,
    getConnectionToken: () => "lease-tok",
    requestWithAuth: async (subpath: string, _method: "GET" | "POST", body?: Record<string, unknown>) =>
      handler(subpath, body ?? {}),
  };
}

test("CMS Global Auth fallback resolves via auth/context and executes once only when session absent", async () => {
  const sentBodies: Record<string, unknown>[] = [];
  let runnerCalls = 0;
  const conn = makeConnection(async (subpath, body) => {
    if (subpath.endsWith("/auth/context")) {
      sentBodies.push(body);
      return {
        ok: true,
        match: "unique",
        count: 1,
        action_tag_id: 99,
        action_tag_key: "wordpress.login",
        resolution_source: "cms_global",
        cms_type: "wordpress",
      };
    }
    if (subpath.endsWith("/auth/resolve") || subpath.endsWith("/auth/pull")) {
      return { ok: true, release: makeRelease(99, "wordpress.login") };
    }
    throw new Error(subpath);
  });

  const finder = new AuthContextFinder(conn);
  const found = await finder.findForAccount("acc-wp-1", {
    siteUrl: "https://site-a.test",
    platform: "site_a",
  });
  assert.equal(found.kind, "unique");
  if (found.kind !== "unique") return;
  assert.equal(found.tag.resolutionSource, "cms_global");
  assert.equal(found.tag.cmsType, "wordpress");
  assert.equal(sentBodies[0].site_url, "https://site-a.test");

  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: {
      run: async () => {
        runnerCalls += 1;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    } satisfies AuthRunnerLike,
  });

  let cpCall = 0;
  const result = await orchestrator.runAfterBrowserOpen({
    browserId: "b-wp-1",
    accountId: "acc-wp-1",
    partition: "persist:b-wp-1",
    tag: found.tag,
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-wp-1", getPassword: async () => "secret" },
    runCheckpoint: async () => {
      cpCall += 1;
      return {
        status: cpCall === 1 ? "absent" : "present",
        method: "wordpress_auth_cookie",
        checkedAt: new Date().toISOString(),
      };
    },
  });

  assert.equal(runnerCalls, 1);
  assert.equal(result.code, "CHECKPOINT_PASSED");
  assert.equal(result.resolutionSource, "cms_global");
  assert.equal(result.authRuns, 1);
});

test("Do not execute Login merely because a Global Auth Script exists when session is already valid", async () => {
  let resolveCalled = false;
  let runnerCalled = false;
  const conn = makeConnection(async (subpath) => {
    if (subpath.endsWith("/auth/context")) {
      return {
        ok: true,
        match: "unique",
        count: 1,
        action_tag_id: 99,
        action_tag_key: "wordpress.login",
        cms_global: true,
      };
    }
    resolveCalled = true;
    throw new Error(`Unexpected call: ${subpath}`);
  });

  const found = await new AuthContextFinder(conn).findForAccount("acc-wp-2");
  assert.equal(found.kind, "unique");
  if (found.kind !== "unique") return;
  assert.equal(found.tag.resolutionSource, "cms_global");

  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: {
      run: async () => {
        runnerCalled = true;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });

  const result = await orchestrator.runAfterBrowserOpen({
    browserId: "b-wp-2",
    accountId: "acc-wp-2",
    partition: "persist:b-wp-2",
    tag: found.tag,
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-wp-2", getPassword: async () => "secret" },
    runCheckpoint: async () => ({
      status: "present",
      method: "wordpress_auth_cookie",
      checkedAt: new Date().toISOString(),
    }),
  });

  assert.equal(resolveCalled, false);
  assert.equal(runnerCalled, false);
  assert.equal(result.code, "SESSION_VALID");
  assert.equal(result.authRuns, 0);
  assert.equal(result.resolutionSource, "cms_global");
});

test("Site-specific and Account Hard Pin scopes are preserved + not_required + restart", async () => {
  const siteParsed = parseAuthContextResponse(
    {
      ok: true,
      match: "unique",
      count: 1,
      action_tag_id: 6,
      action_tag_key: "mayhopphat.login",
      resolution_source: "site_specific",
      site_id: "site-6",
    },
    "acc-1"
  );
  assert.equal(siteParsed.kind, "unique");
  if (siteParsed.kind === "unique") {
    assert.equal(siteParsed.tag.resolutionSource, "site_specific");
    assert.equal(siteParsed.tag.siteId, "site-6");
  }

  const pinParsed = parseAuthContextResponse(
    {
      ok: true,
      match: "unique",
      count: 1,
      action_tag_id: 7,
      action_tag_key: "custom.login",
      resolution_source: "account_hard_pin",
    },
    "acc-2"
  );
  assert.equal(pinParsed.kind, "unique");
  if (pinParsed.kind === "unique") {
    assert.equal(pinParsed.tag.resolutionSource, "account_pin");
  }

  const notReq = parseAuthContextResponse({ ok: true, auth_required: false }, "acc-3");
  assert.equal(notReq.kind, "not_required");

  // Missing context (NO_TAG_CONTEXT) is never treated as authenticated when checkpoint is absent
  const conn = makeConnection(async () => ({ ok: true }));
  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: { run: async () => ({ kind: "ok" as const, stepsExecuted: 0 }) },
  });
  const noCtx = await orchestrator.runAfterBrowserOpen({
    browserId: "b-no-ctx",
    accountId: "acc-no-ctx",
    partition: "persist:b-no-ctx",
    tag: undefined,
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-no-ctx", getPassword: async () => "" },
    runCheckpoint: async () => ({
      status: "absent",
      method: "wordpress_auth_cookie",
      checkedAt: new Date().toISOString(),
    }),
  });
  assert.equal(noCtx.code, "NO_TAG_CONTEXT");
  assert.equal(noCtx.checkpointStatus, "absent");
  assert.equal(noCtx.authExecutionOk, false);
});

test("UI auth status helper maps all 5 meaningful statuses", () => {
  assert.equal(formatAuthStatusDisplay("NO_TAG_CONTEXT")?.label, "No Site/Account context");
  assert.equal(formatAuthStatusDisplay("CHECKPOINT_PASSED", "cms_global")?.label, "Auth Script resolved");
  assert.match(formatAuthStatusDisplay("CHECKPOINT_PASSED", "cms_global")?.detail ?? "", /CMS Global/);
  assert.equal(formatAuthStatusDisplay("AUTH_NOT_REQUIRED")?.label, "Authentication not required");
  assert.equal(formatAuthStatusDisplay("SESSION_VALID")?.label, "Authentication not required");
  assert.equal(formatAuthStatusDisplay("NO_AUTH_CONFIGURED")?.label, "Auth Script missing");
  assert.equal(formatAuthStatusDisplay("AUTH_EXECUTION_FAILED")?.label, "Auth execution blocked");
  assert.equal(formatAuthStatusDisplay("AUTH_CONTEXT_AMBIGUOUS")?.label, "Auth execution blocked");
});
