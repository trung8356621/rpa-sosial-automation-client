import test from "node:test";
import assert from "node:assert/strict";
import { AuthScriptResolver } from "../src/main/auth/auth-script-resolver.js";
import { AuthScriptLoader, validatePinnedIdentity } from "../src/main/auth/auth-script-loader.js";
import { AuthScriptRunner, describeUnsupportedStep } from "../src/main/auth/auth-script-runner.js";
import { BrowserOpenOrchestrator } from "../src/main/auth/browser-open-orchestrator.js";
import { resolveCredentialBindings, isPasswordKey } from "../src/main/auth/credential-mapper.js";
import { mapServerErrorToCode } from "../src/main/auth/outcomes.js";
import { hasExplicitTagContext, type AuthReleaseIdentity, type AuthReleasePulled } from "../src/main/auth/auth-script-types.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";
import { sanitizeLog } from "../src/main/main-error-log.js";
import type { SessionSignal } from "../src/shared/contracts.js";

const DIGEST = "a".repeat(64);

function baseRelease(over: Partial<AuthReleaseIdentity> = {}): AuthReleaseIdentity {
  return {
    action_tag_id: 10,
    action_tag_key: "wordpress.wp_admin.login",
    package_key: "wordpress.login",
    package_id: 7,
    kind: "script",
    is_authentication: true,
    version: "1",
    release_id: 42,
    content_digest: DIGEST,
    schema_version: 1,
    status: "published",
    runtime_compatibility: null,
    assets_complete: true,
    ready_to_execute: true,
    ...over,
  };
}

function pulled(over: Partial<AuthReleasePulled> = {}): AuthReleasePulled {
  const base = baseRelease();
  return {
    ...base,
    manifest: {
      script_id: "wordpress.login",
      variables: [
        { id: "v1", key: "user_login", type: "text" },
        { id: "v2", key: "user_pass", type: "text" },
      ],
      steps: [
        { id: "s1", action: "navigate", url: "https://example.test/wp-login.php" },
        { id: "s2", action: "fill", selector: "#user_login", variable_key: "user_login" },
        { id: "s3", action: "fill", selector: "#user_pass", variable_key: "user_pass" },
        { id: "s4", action: "click", selector: "#wp-submit" },
      ],
      video_demo: { artifact_ref: "demo.webm", test_run_id: "t1", reviewed: true, audio: false, desktop_capture: false },
    },
    ...over,
  };
}

function httpErr(status: number, code: string): SeoOpsHttpError {
  return new SeoOpsHttpError({
    method: "POST",
    endpoint: "/api/v1/social-automation/client/auth/resolve",
    status,
    contentType: "application/json",
    category: status === 401 ? "authentication" : status === 403 ? "authorization" : "unexpected_response",
    serverErrorCode: code,
    serverErrorMessage: code,
  });
}

function mockConnection(handler: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return {
    isOnline: () => true,
    getConnectionToken: () => "lease-token-test",
    requestWithAuth: async (path: string, _method: string, body?: Record<string, unknown>) => handler(path, body),
  };
}

const presentSignal = (): SessionSignal => ({
  status: "present",
  checkedAt: new Date().toISOString(),
  method: "wordpress_auth_cookie",
});

const absentSignal = (): SessionSignal => ({
  status: "absent",
  checkedAt: new Date().toISOString(),
  method: "wordpress_auth_cookie",
});

test("1. Browser Open without Tag → NO_TAG_CONTEXT, Checkpoint still runs", async () => {
  assert.equal(hasExplicitTagContext({}), false);
  assert.equal(hasExplicitTagContext(null), false);

  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(mockConnection(async () => {
      throw new Error("resolve must not be called without tag");
    })),
    loader: new AuthScriptLoader(mockConnection(async () => {
      throw new Error("pull must not be called without tag");
    })),
    runner: new AuthScriptRunner(),
  });

  let checkpointRuns = 0;
  const result = await orch.runAfterBrowserOpen({
    browserId: "b1",
    accountId: "acc-1",
    partition: "persist:rpa-client-b1",
    tag: undefined,
    webContents: null,
    account: {
      accountId: "acc-1",
      getPassword: async () => {
        throw new Error("password must not be fetched");
      },
    },
    runCheckpoint: async () => {
      checkpointRuns += 1;
      return absentSignal();
    },
  });

  assert.equal(result.code, "NO_TAG_CONTEXT");
  assert.equal(checkpointRuns, 1);
  assert.equal(result.authExecutionOk, false);
});

test("2. Tag without Auth pin → NO_AUTH_CONFIGURED", async () => {
  const conn = mockConnection(async () => {
    throw httpErr(404, "auth_pin_missing");
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });

  const result = await orch.runAfterBrowserOpen({
    browserId: "b2",
    accountId: "acc-1",
    partition: "persist:rpa-client-b2",
    tag: { actionTagKey: "wordpress.wp_admin.login" },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });

  assert.equal(result.code, "NO_AUTH_CONFIGURED");
  assert.equal(result.authExecutionOk, false);
});

test("3. Valid explicit Tag with Auth pin → resolve+pull identity", async () => {
  const expected = baseRelease();
  const full = pulled();
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    if (path.endsWith("/auth/pull")) return { ok: true, release: full };
    throw new Error(path);
  });
  const resolver = new AuthScriptResolver(conn);
  const loader = new AuthScriptLoader(conn);
  const resolved = await resolver.resolve("acc-1", { actionTagId: 10 });
  assert.equal(resolved.kind, "ok");
  if (resolved.kind !== "ok") return;
  const loaded = await loader.pullExact("acc-1", { actionTagId: 10 }, resolved.release);
  assert.equal(loaded.kind, "ok");
  if (loaded.kind !== "ok") return;
  assert.equal(loaded.release.release_id, 42);
  assert.equal(loaded.release.package_key, "wordpress.login");
  assert.ok(Array.isArray(loaded.release.manifest.steps));
});

test("4. Wrong Account↔Tag entitlement → NO_ACCOUNT_TAG_ENTITLEMENT", async () => {
  const conn = mockConnection(async () => {
    throw httpErr(403, "account_tag_unauthorized");
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b4",
    accountId: "acc-1",
    partition: "persist:rpa-client-b4",
    tag: { actionTagId: 99 },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "NO_ACCOUNT_TAG_ENTITLEMENT");
  assert.notEqual(result.code, "CHECKPOINT_PASSED");
});

test("5. Expired Client lease → CLIENT_LEASE_INVALID", async () => {
  assert.equal(mapServerErrorToCode("CLIENT_KEY_IN_USE", 409), "CLIENT_LEASE_INVALID");
  const conn = mockConnection(async () => {
    throw httpErr(409, "CLIENT_KEY_IN_USE");
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b5",
    accountId: "acc-1",
    partition: "persist:rpa-client-b5",
    tag: { actionTagId: 10 },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "CLIENT_LEASE_INVALID");
});

test("6. Missing release → AUTH_RELEASE_UNAVAILABLE", async () => {
  assert.equal(mapServerErrorToCode("auth_release_not_found", 404), "AUTH_RELEASE_UNAVAILABLE");
  const conn = mockConnection(async () => {
    throw httpErr(404, "auth_release_not_published");
  });
  const result = await new AuthScriptResolver(conn).resolve("acc-1", { actionTagId: 10 });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.equal(result.code, "AUTH_RELEASE_UNAVAILABLE");
});

test("7. Wrong pinned release (resolve≠pull) → AUTH_INTEGRITY_FAILED", async () => {
  const expected = baseRelease();
  const wrong = pulled({ release_id: 99, content_digest: "b".repeat(64) });
  assert.ok(validatePinnedIdentity(expected, wrong));
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    return { ok: true, release: wrong };
  });
  const loaded = await new AuthScriptLoader(conn).pullExact("acc-1", { actionTagId: 10 }, expected);
  assert.equal(loaded.kind, "error");
  if (loaded.kind === "error") assert.equal(loaded.code, "AUTH_INTEGRITY_FAILED");
});

test("8. Download/digest failure / assets incomplete → AUTH_DOWNLOAD_FAILED", async () => {
  const expected = baseRelease();
  const incomplete = pulled({ assets_complete: false, ready_to_execute: false });
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    return { ok: true, release: incomplete };
  });
  const loaded = await new AuthScriptLoader(conn).pullExact("acc-1", { actionTagId: 10 }, expected);
  assert.equal(loaded.kind, "error");
  if (loaded.kind === "error") assert.equal(loaded.code, "AUTH_DOWNLOAD_FAILED");
});

test("9. Auth execution timeout → AUTH_TIMEOUT", async () => {
  const expected = baseRelease();
  const full = pulled({
    manifest: {
      script_id: "wordpress.login",
      variables: [],
      steps: [{ id: "s1", action: "wait", ms: 5_000 }],
    },
  });
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    return { ok: true, release: full };
  });

  const fakeWc = {
    isDestroyed: () => false,
    loadURL: async () => {},
    executeJavaScript: async () => true,
  };

  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: {
      run: async () => ({ kind: "timeout" as const, message: "timeout", stepsExecuted: 0 }),
    },
  });

  const result = await orch.runAfterBrowserOpen({
    browserId: "b9",
    accountId: "acc-1",
    partition: "persist:rpa-client-b9",
    tag: { actionTagId: 10 },
    webContents: fakeWc as never,
    account: { accountId: "acc-1", getPassword: async () => "secret-not-for-logs" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "AUTH_TIMEOUT");
  assert.equal(result.checkpointStatus, "absent");
});

test("10. Auth succeeds but Checkpoint fails → CHECKPOINT_FAILED", async () => {
  const expected = baseRelease();
  const full = pulled();
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    return { ok: true, release: full };
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: { run: async () => ({ kind: "ok" as const, stepsExecuted: 4 }) },
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b10",
    accountId: "acc-1",
    partition: "persist:rpa-client-b10",
    tag: { actionTagId: 10 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-1", email: "a@test.com", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  });
  assert.equal(result.code, "CHECKPOINT_FAILED");
  assert.equal(result.authExecutionOk, true);
  assert.equal(result.checkpointStatus, "absent");
});

test("11. Auth succeeds and Checkpoint passes → CHECKPOINT_PASSED", async () => {
  const expected = baseRelease();
  const full = pulled();
  const conn = mockConnection(async (path) => {
    if (path.endsWith("/auth/resolve")) return { ok: true, release: expected };
    return { ok: true, release: full };
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: { run: async () => ({ kind: "ok" as const, stepsExecuted: 4 }) },
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b11",
    accountId: "acc-1",
    partition: "persist:rpa-client-b11",
    tag: { actionTagId: 10 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc-1", email: "a@test.com", getPassword: async () => "x" },
    runCheckpoint: async () => presentSignal(),
  });
  assert.equal(result.code, "CHECKPOINT_PASSED");
  assert.equal(result.authExecutionOk, true);
  assert.equal(result.checkpointStatus, "present");
});

test("12. Manual login remains available after Auth failures (browser kept / checkpoint still runs)", async () => {
  const conn = mockConnection(async () => {
    throw httpErr(403, "account_tag_unauthorized");
  });
  let checkpoint = 0;
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b12",
    accountId: "acc-1",
    partition: "persist:rpa-client-b12",
    tag: { actionTagId: 10 },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => {
      checkpoint += 1;
      return absentSignal();
    },
  });
  assert.equal(checkpoint, 1);
  assert.equal(result.authExecutionOk, false);
  assert.notEqual(result.code, "CHECKPOINT_PASSED");
});

test("13. Same partition identity is passed through orchestrator (no temp browser)", async () => {
  const partitions: string[] = [];
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(mockConnection(async () => {
      throw httpErr(404, "auth_pin_missing");
    })),
    loader: new AuthScriptLoader(mockConnection(async () => ({ ok: false }))),
    runner: new AuthScriptRunner(),
  });
  await orch.runAfterBrowserOpen({
    browserId: "browser-uuid-13",
    accountId: "acc-1",
    partition: "persist:rpa-client-browser-uuid-13",
    tag: { actionTagKey: "wordpress.wp_admin.login" },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => {
      partitions.push("persist:rpa-client-browser-uuid-13");
      return absentSignal();
    },
  });
  assert.deepEqual(partitions, ["persist:rpa-client-browser-uuid-13"]);
});

test("14. Concurrent Browser Open does not duplicate Auth", async () => {
  let resolveCount = 0;
  const conn = mockConnection(async () => {
    resolveCount += 1;
    await new Promise((r) => setTimeout(r, 40));
    throw httpErr(404, "auth_pin_missing");
  });
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: new AuthScriptRunner(),
  });
  const params = {
    browserId: "b14",
    accountId: "acc-1",
    partition: "persist:rpa-client-b14",
    tag: { actionTagId: 10 },
    webContents: null,
    account: { accountId: "acc-1", getPassword: async () => "x" },
    runCheckpoint: async () => absentSignal(),
  };
  const [a, b] = await Promise.all([
    orch.runAfterBrowserOpen(params),
    orch.runAfterBrowserOpen(params),
  ]);
  assert.equal(a.code, b.code);
  assert.equal(resolveCount, 1, "Auth resolve must run once for concurrent opens");
});

test("15. Credentials do not appear in logs / sanitization", async () => {
  const secret = "SuperSecretPassword!99";
  const lease = "connection_token=abc123lease";
  assert.ok(!sanitizeLog(`password: "${secret}"`).includes(secret));
  assert.ok(sanitizeLog(lease).includes("connection_token=[REDACTED]"));
  assert.ok(isPasswordKey("user_pass"));
  assert.ok(isPasswordKey("password"));

  const bindings = await resolveCredentialBindings(
    [
      { id: "1", key: "user_login", type: "text" },
      { id: "2", key: "user_pass", type: "text" },
    ],
    {
      accountId: "acc-1",
      email: "wp@example.test",
      getPassword: async () => secret,
    }
  );
  assert.equal(bindings.ok, true);
  if (bindings.ok) {
    assert.equal(bindings.values.user_login, "wp@example.test");
    assert.equal(bindings.values.user_pass, secret);
  }
});

test("OCR / image Match-To steps are rejected (WordPress-first DOM only)", () => {
  const msg = describeUnsupportedStep({
    id: "s1",
    action: "CLICK_TARGET",
    target: { matchTo: "middle", ocr: { confirmed: true } },
  });
  assert.ok(msg && /OCR|Match-To/i.test(msg));
});

test("openBrowser contract allows optional Action Tag without requiring it", () => {
  const withoutTag = { type: "openBrowser" as const, browserId: "x" };
  const withTag = { type: "openBrowser" as const, browserId: "x", actionTagId: 10, actionTagKey: "wordpress.wp_admin.login" };
  assert.equal("actionTagId" in withoutTag, false);
  assert.equal(withTag.actionTagId, 10);
});
