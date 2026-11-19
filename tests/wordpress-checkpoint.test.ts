import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieBelongsToHost,
  evaluateWordPressSession,
  isWordPressAdminUrl,
  isWordPressLoginUrl,
  resolveBrowserOpenUrl,
  resolveSessionStrategy,
} from "../src/main/browser/session-signal-strategy.js";
import { BrowserOpenOrchestrator } from "../src/main/auth/browser-open-orchestrator.js";
import type { SessionSignal } from "../src/shared/contracts.js";

test("WordPress admin URL detection excludes login form", () => {
  assert.equal(isWordPressAdminUrl("https://mayhopphat.com/wp-admin/"), true);
  assert.equal(isWordPressAdminUrl("https://mayhopphat.com/wp-admin/index.php"), true);
  assert.equal(isWordPressAdminUrl("https://mayhopphat.com/wp-login.php?reauth=1"), false);
  assert.equal(isWordPressLoginUrl("https://mayhopphat.com/wp-login.php?reauth=1"), true);
});

test("Reopen prefers /wp-admin/ over wp-login?reauth to avoid clearing session", () => {
  const url = resolveBrowserOpenUrl({
    lastUrl: "https://mayhopphat.com/wp-login.php?redirect_to=%2Fwp-admin%2F&reauth=1",
    siteUrl: "https://mayhopphat.com",
    platform: "mayhopphat",
    fallback: () => "https://example.com",
  });
  assert.equal(url, "https://mayhopphat.com/wp-admin/");
});

test("Cookie domain matching tolerates leading-dot Electron domains", () => {
  assert.equal(cookieBelongsToHost(".mayhopphat.com", "mayhopphat.com"), true);
  assert.equal(cookieBelongsToHost("mayhopphat.com", "www.mayhopphat.com"), true);
  assert.equal(cookieBelongsToHost("evil.com", "mayhopphat.com"), false);
});

test("WordPress checkpoint PASS via auth cookie alone", () => {
  const signal = evaluateWordPressSession({
    cookies: [{ name: "wordpress_logged_in_abc" }],
    pageUrl: "https://mayhopphat.com/wp-login.php",
    dom: { hasAdminBar: false, hasWpBody: false, bodyHasWpAdmin: false },
    checkedAt: "now",
  });
  assert.equal(signal.status, "present");
  assert.equal(signal.method, "wordpress_auth_cookie");
});

test("WordPress checkpoint PASS via /wp-admin/ + #wpadminbar without inventing client flag", () => {
  const signal = evaluateWordPressSession({
    cookies: [],
    pageUrl: "https://mayhopphat.com/wp-admin/",
    dom: { hasAdminBar: true, hasWpBody: true, bodyHasWpAdmin: true },
    checkedAt: "now",
  });
  assert.equal(signal.status, "present");
  assert.equal(signal.method, "wordpress_admin_dom");
});

test("WordPress checkpoint ABSENT when login page and no cookies/DOM", () => {
  const signal = evaluateWordPressSession({
    cookies: [{ name: "wordpress_test_cookie" }],
    pageUrl: "https://mayhopphat.com/wp-login.php",
    dom: { hasAdminBar: false, hasWpBody: false, bodyHasWpAdmin: false },
    checkedAt: "now",
  });
  assert.equal(signal.status, "absent");
});

test("Different host strategy does not borrow WordPress session", () => {
  assert.equal(resolveSessionStrategy("https://www.facebook.com/", "https://mayhopphat.com/"), "facebook");
});

const DIGEST = "b".repeat(64);
const present = (): SessionSignal => ({
  status: "present",
  checkedAt: new Date().toISOString(),
  method: "wordpress_auth_cookie",
});
const absent = (): SessionSignal => ({
  status: "absent",
  checkedAt: new Date().toISOString(),
  method: "wordpress_auth_cookie",
});
const unknown = (): SessionSignal => ({
  status: "unknown",
  checkedAt: null,
  method: null,
});

test("Close/reopen same partition: present checkpoint → SESSION_VALID Auth runs=0", async () => {
  const { AuthScriptResolver } = await import("../src/main/auth/auth-script-resolver.js");
  const { AuthScriptLoader } = await import("../src/main/auth/auth-script-loader.js");
  let checkpoints = 0;
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async () => {
      throw new Error("resolve must not run when session valid");
    },
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: {
      run: async () => {
        throw new Error("Auth must not run");
      },
    },
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b1",
    accountId: "acc",
    partition: "persist:rpa-client-same",
    tag: { actionTagId: 6, actionTagKey: "mayhopphat.login" },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc", getPassword: async () => "x" },
    runCheckpoint: async () => {
      checkpoints += 1;
      return present();
    },
  });
  assert.equal(result.code, "SESSION_VALID");
  assert.equal(result.authRuns, 0);
  assert.equal(checkpoints, 1);
});

test("Unknown signal → SESSION_UNKNOWN, Auth runs=0 (not treated as logout)", async () => {
  const { AuthScriptResolver } = await import("../src/main/auth/auth-script-resolver.js");
  const { AuthScriptLoader } = await import("../src/main/auth/auth-script-loader.js");
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async () => {
      throw new Error("must not resolve");
    },
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: { run: async () => ({ kind: "ok" as const, stepsExecuted: 0 }) },
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b-unk",
    accountId: "acc",
    partition: "persist:x",
    tag: { actionTagId: 6 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc", getPassword: async () => "x" },
    runCheckpoint: async () => unknown(),
  });
  assert.equal(result.code, "SESSION_UNKNOWN");
  assert.equal(result.authRuns, 0);
});

test("Expired/absent session → Auth may run once then post-auth settle checkpoint", async () => {
  const { AuthScriptResolver } = await import("../src/main/auth/auth-script-resolver.js");
  const { AuthScriptLoader } = await import("../src/main/auth/auth-script-loader.js");
  const release = {
    action_tag_id: 6,
    action_tag_key: "mayhopphat.login",
    package_key: "pkg",
    package_id: 1,
    kind: "script",
    is_authentication: true,
    version: "1",
    release_id: 3,
    content_digest: DIGEST,
    schema_version: 1,
    status: "published",
    assets_complete: true,
    ready_to_execute: true,
    manifest: { steps: [{ action: "wait", ms: 1 }], variables: [] },
  };
  let authRuns = 0;
  let cp = 0;
  const conn = {
    isOnline: () => true,
    getConnectionToken: () => "lease",
    requestWithAuth: async () => ({ ok: true, release }),
  };
  const orch = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    runner: {
      run: async () => {
        authRuns += 1;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });
  const result = await orch.runAfterBrowserOpen({
    browserId: "b-exp",
    accountId: "acc",
    partition: "persist:a",
    tag: { actionTagId: 6 },
    webContents: { isDestroyed: () => false } as never,
    account: { accountId: "acc", username: "u", getPassword: async () => "x" },
    runCheckpoint: async () => {
      cp += 1;
      // initial absent, post-auth present (simulates settle after redirect)
      return cp === 1 ? absent() : present();
    },
  });
  assert.equal(authRuns, 1);
  assert.equal(result.authRuns, 1);
  assert.equal(result.code, "CHECKPOINT_PASSED");
});
