import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_VIEWPORT, clampExecutionBounds } from "../src/main/browser/execution-viewport.js";
import { validateAuthNavigationTarget, isAtAuthTarget } from "../src/main/auth/auth-navigation.js";
import { AuthContextFinder } from "../src/main/auth/auth-context-finder.js";
import { AuthScriptResolver } from "../src/main/auth/auth-script-resolver.js";
import { AuthScriptLoader } from "../src/main/auth/auth-script-loader.js";
import { BrowserOpenOrchestrator } from "../src/main/auth/browser-open-orchestrator.js";

const DIGEST = "b".repeat(64);

function makeRelease(actionTagId: number, actionTagKey: string) {
  return {
    action_tag_id: actionTagId,
    action_tag_key: actionTagKey,
    package_key: "pkg-wp-global",
    package_id: 3,
    kind: "script",
    is_authentication: true,
    version: "1",
    release_id: 3,
    content_digest: DIGEST,
    schema_version: 1,
    status: "published",
    assets_complete: true,
    ready_to_execute: true,
    manifest: { steps: [{ action: "fill", selector: "#user_login", variable_key: "username" }] },
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

test("execution viewport stays pinned to 1024x560 zoom 1.0 across resize/maximize/sidebar changes", () => {
  assert.deepEqual(EXECUTION_VIEWPORT, { width: 1024, height: 560, zoom: 1.0 });

  // Larger maximized window -> never stretches beyond 1024x560
  assert.deepEqual(clampExecutionBounds({ x: 280, y: 96, width: 1640, height: 920 }), {
    x: 280,
    y: 96,
    width: 1024,
    height: 560,
  });

  // Smaller container / sidebar shift -> keeps 1024x560 execution coordinate space
  assert.deepEqual(clampExecutionBounds({ x: 80.4, y: 112.6, width: 680, height: 420 }), {
    x: 80,
    y: 113,
    width: 1024,
    height: 560,
  });
});

test("CMS Global login navigates to execution_context.resolved_url (/wp-login.php) before Step 0", async () => {
  let currentUrl = "https://maytuicanvas.com/";
  const eventsOrder: string[] = [];

  const conn = makeConnection(async (subpath) => {
    if (subpath.endsWith("/auth/context")) {
      return {
        ok: true,
        match: "unique",
        count: 1,
        action_tag_id: 15,
        action_tag_key: "maytuicanvas.login",
        resolution_source: "cms_global",
        execution_context: {
          resolved_url: "https://maytuicanvas.com/wp-login.php",
          site_url: "https://maytuicanvas.com",
          auth_path: "/wp-login.php",
          source: "cms_global",
        },
      };
    }
    if (subpath.endsWith("/auth/resolve") || subpath.endsWith("/auth/pull")) {
      return {
        ok: true,
        release: makeRelease(15, "maytuicanvas.login"),
        execution_context: {
          resolved_url: "https://maytuicanvas.com/wp-login.php",
          site_url: "https://maytuicanvas.com",
          auth_path: "/wp-login.php",
        },
      };
    }
    throw new Error(subpath);
  });

  const found = await new AuthContextFinder(conn).findForAccount("acc-maytuicanvas", {
    siteUrl: "https://maytuicanvas.com",
    platform: "maytuicanvas",
  });
  assert.equal(found.kind, "unique");
  if (found.kind !== "unique") return;
  assert.equal(found.tag.executionContext?.resolvedUrl, "https://maytuicanvas.com/wp-login.php");

  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    navigateToAuthUrl: async (url) => {
      eventsOrder.push(`navigate:${url}`);
      currentUrl = url;
    },
    runner: {
      run: async () => {
        eventsOrder.push(`step0:${currentUrl}`);
        assert.equal(currentUrl, "https://maytuicanvas.com/wp-login.php");
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });

  let cpCall = 0;
  const result = await orchestrator.runAfterBrowserOpen({
    browserId: "b-maytuicanvas",
    accountId: "acc-maytuicanvas",
    partition: "persist:rpa-client-b-maytuicanvas",
    tag: found.tag,
    webContents: {
      isDestroyed: () => false,
      getURL: () => currentUrl,
    } as never,
    account: {
      accountId: "acc-maytuicanvas",
      siteUrl: "https://maytuicanvas.com",
      getPassword: async () => "pw",
    },
    runCheckpoint: async () => {
      cpCall += 1;
      return {
        status: cpCall === 1 ? "absent" : "present",
        method: "wordpress_auth_cookie",
        checkedAt: new Date().toISOString(),
      };
    },
  });

  assert.equal(result.code, "CHECKPOINT_PASSED");
  assert.deepEqual(eventsOrder, [
    "navigate:https://maytuicanvas.com/wp-login.php",
    "step0:https://maytuicanvas.com/wp-login.php",
  ]);
});

test("SESSION_VALID skips authentication navigation and execution", async () => {
  let navCalled = false;
  let runnerCalled = false;
  const conn = makeConnection(async () => {
    throw new Error("Should not resolve/pull when SESSION_VALID");
  });

  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    navigateToAuthUrl: async () => {
      navCalled = true;
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });

  const result = await orchestrator.runAfterBrowserOpen({
    browserId: "b-valid",
    accountId: "acc-valid",
    partition: "persist:rpa-client-b-valid",
    tag: {
      actionTagId: 15,
      actionTagKey: "maytuicanvas.login",
      resolutionSource: "cms_global",
      executionContext: { resolvedUrl: "https://maytuicanvas.com/wp-login.php" },
    },
    webContents: {
      isDestroyed: () => false,
      getURL: () => "https://maytuicanvas.com/wp-admin/",
    } as never,
    account: { accountId: "acc-valid", siteUrl: "https://maytuicanvas.com", getPassword: async () => "pw" },
    runCheckpoint: async () => ({
      status: "present",
      method: "wordpress_auth_cookie",
      checkedAt: new Date().toISOString(),
    }),
  });

  assert.equal(result.code, "SESSION_VALID");
  assert.equal(navCalled, false);
  assert.equal(runnerCalled, false);
});

test("wrong-origin URL is blocked and navigation failure yields AUTH_NAVIGATION_FAILED", async () => {
  const bad = validateAuthNavigationTarget({
    targetUrl: "https://evil.example/wp-login.php",
    authorizedSiteUrl: "https://maytuicanvas.com",
    expectedAuthPath: "/wp-login.php",
  });
  assert.equal(bad.ok, false);
  assert.equal(
    isAtAuthTarget("https://maytuicanvas.com/wp-login.php?redirect_to=%2F", {
      origin: "https://maytuicanvas.com",
      pathname: "/wp-login.php",
    }),
    true
  );

  let runnerCalled = false;
  const conn = makeConnection(async (subpath) => {
    if (subpath.endsWith("/auth/resolve") || subpath.endsWith("/auth/pull")) {
      return {
        ok: true,
        release: makeRelease(15, "maytuicanvas.login"),
        execution_context: { resolved_url: "https://evil.example/wp-login.php" },
      };
    }
    throw new Error(subpath);
  });

  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    navigateToAuthUrl: async () => {
      throw new Error("Should not navigate to wrong origin");
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });

  const blocked = await orchestrator.runAfterBrowserOpen({
    browserId: "b-evil",
    accountId: "acc-1",
    partition: "persist:b-evil",
    tag: { actionTagId: 15, actionTagKey: "maytuicanvas.login" },
    webContents: { isDestroyed: () => false, getURL: () => "https://maytuicanvas.com/" } as never,
    account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "pw" },
    runCheckpoint: async () => ({
      status: "absent",
      method: "wordpress_auth_cookie",
      checkedAt: new Date().toISOString(),
    }),
  });
  assert.equal(blocked.code, "AUTH_NAVIGATION_FAILED");
  assert.equal(runnerCalled, false);

  // Valid origin but network navigation failure -> explicit AUTH_NAVIGATION_FAILED
  const connOk = makeConnection(async (subpath) => {
    if (subpath.endsWith("/auth/resolve") || subpath.endsWith("/auth/pull")) {
      return {
        ok: true,
        release: makeRelease(15, "maytuicanvas.login"),
        execution_context: { resolved_url: "https://maytuicanvas.com/wp-login.php" },
      };
    }
    throw new Error(subpath);
  });
  const orchNavFail = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(connOk),
    loader: new AuthScriptLoader(connOk),
    navigateToAuthUrl: async () => {
      throw new Error("ERR_NAME_NOT_RESOLVED");
    },
    runner: {
      run: async () => {
        runnerCalled = true;
        return { kind: "ok" as const, stepsExecuted: 1 };
      },
    },
  });
  const navFail = await orchNavFail.runAfterBrowserOpen({
    browserId: "b-nav-fail",
    accountId: "acc-1",
    partition: "persist:b-nav-fail",
    tag: { actionTagId: 15, actionTagKey: "maytuicanvas.login" },
    webContents: { isDestroyed: () => false, getURL: () => "https://maytuicanvas.com/" } as never,
    account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "pw" },
    runCheckpoint: async () => ({
      status: "absent",
      method: "wordpress_auth_cookie",
      checkedAt: new Date().toISOString(),
    }),
  });
  assert.equal(navFail.code, "AUTH_NAVIGATION_FAILED");
  assert.match(navFail.message, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(runnerCalled, false);
});

test("Site-specific Auth without execution_context remains compatible", async () => {
  let navCalled = false;
  const conn = makeConnection(async (subpath) => {
    if (subpath.endsWith("/auth/resolve") || subpath.endsWith("/auth/pull")) {
      return { ok: true, release: makeRelease(6, "mayhopphat.login") };
    }
    throw new Error(subpath);
  });
  const orchestrator = new BrowserOpenOrchestrator({
    resolver: new AuthScriptResolver(conn),
    loader: new AuthScriptLoader(conn),
    navigateToAuthUrl: async () => {
      navCalled = true;
    },
    runner: {
      run: async () => ({ kind: "ok" as const, stepsExecuted: 1 }),
    },
  });

  let cp = 0;
  const ok = await orchestrator.runAfterBrowserOpen({
    browserId: "b-site",
    accountId: "acc-site",
    partition: "persist:b-site",
    tag: { actionTagId: 6, actionTagKey: "mayhopphat.login", resolutionSource: "site_specific" },
    webContents: { isDestroyed: () => false, getURL: () => "https://mayhopphat.com/wp-login.php" } as never,
    account: { accountId: "acc-site", siteUrl: "https://mayhopphat.com", getPassword: async () => "pw" },
    runCheckpoint: async () => {
      cp += 1;
      return { status: cp === 1 ? "absent" : "present", method: "wordpress_auth_cookie", checkedAt: new Date().toISOString() };
    },
  });
  assert.equal(ok.code, "CHECKPOINT_PASSED");
  assert.equal(navCalled, false);
});
