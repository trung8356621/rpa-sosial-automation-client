import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { AuthScriptRunner, HUMAN_REQUIRED_DETECTION_SCRIPT } from "../src/main/auth/auth-script-runner.js";
import type { AuthReleasePulled } from "../src/main/auth/auth-script-types.js";

function evalDetectionScript(opts: {
  bodyText?: string;
  matchedSelectors?: Record<string, unknown>;
  computedStyles?: Map<unknown, { display: string; visibility: string }>;
}): unknown {
  const matched = opts.matchedSelectors ?? {};
  const styles = opts.computedStyles ?? new Map();
  const context = {
    document: {
      body: { innerText: opts.bodyText ?? "" },
      querySelector: (selector: string) => matched[selector] ?? null,
    },
    window: {
      getComputedStyle: (el: unknown) => styles.get(el) ?? { display: "block", visibility: "visible" },
    },
  };
  return vm.runInNewContext(HUMAN_REQUIRED_DETECTION_SCRIPT, context);
}

function makeWpAuthCheckNode(opts: {
  wrapHiddenClass?: boolean;
  wrapDisplay?: string;
  selfDisplay?: string;
  rect?: { width: number; height: number };
}) {
  const wrap = {
    classList: { contains: (cls: string) => cls === "hidden" && Boolean(opts.wrapHiddenClass) },
    hasAttribute: () => false,
  };
  const self = {
    classList: { contains: () => false },
    hasAttribute: () => false,
    closest: (sel: string) => (sel === "#wp-auth-check-wrap" ? wrap : null),
    getBoundingClientRect: () => opts.rect ?? { width: 0, height: 0 },
  };
  const styles = new Map<unknown, { display: string; visibility: string }>([
    [wrap, { display: opts.wrapDisplay ?? "block", visibility: "visible" }],
    [self, { display: opts.selfDisplay ?? "block", visibility: "visible" }],
  ]);
  return { self, styles };
}

test("hidden WordPress #wp-auth-check inside #wp-auth-check-wrap.hidden does not trigger HUMAN_REQUIRED", () => {
  const { self, styles } = makeWpAuthCheckNode({
    wrapHiddenClass: true,
    wrapDisplay: "none",
    rect: { width: 0, height: 0 },
  });
  const hit = evalDetectionScript({
    bodyText: "Add Post TEST Mock Title #5",
    matchedSelectors: { "#wp-auth-check": self },
    computedStyles: styles,
  });
  assert.equal(hit, null);
});

test("visible WordPress #wp-auth-check interim login modal triggers HUMAN_REQUIRED", () => {
  const { self, styles } = makeWpAuthCheckNode({
    wrapHiddenClass: false,
    wrapDisplay: "block",
    selfDisplay: "block",
    rect: { width: 380, height: 420 },
  });
  const hit = evalDetectionScript({
    matchedSelectors: { "#wp-auth-check": self },
    computedStyles: styles,
  });
  assert.equal(hit, "captcha_or_verification_ui");
});

test("CAPTCHA selectors and verification text still trigger HUMAN_REQUIRED", () => {
  assert.equal(
    evalDetectionScript({ matchedSelectors: { ".g-recaptcha": {} } }),
    "captcha_or_verification_ui"
  );
  assert.equal(
    evalDetectionScript({ matchedSelectors: { ".cf-challenge": {} } }),
    "captcha_or_verification_ui"
  );
  assert.equal(
    evalDetectionScript({ bodyText: "Please verify you are human to continue" }),
    "captcha_or_verification_text"
  );
});

test("AuthScriptRunner completes multi-step script when #wp-auth-check is hidden and stops when visible", async () => {
  const release: AuthReleasePulled = {
    action_tag_id: 1,
    action_tag_key: "maytuicanvas.create_post",
    package_key: "382f26c4-d39a-4f2d-a8a3-d255f6c65c61",
    package_id: 1,
    kind: "script",
    is_authentication: false,
    version: "1",
    release_id: 12,
    content_digest: "b".repeat(64),
    schema_version: 1,
    status: "published",
    runtime_compatibility: null,
    assets_complete: true,
    ready_to_execute: true,
    manifest: {
      script_id: "382f26c4-d39a-4f2d-a8a3-d255f6c65c61",
      variables: [],
      steps: [
        { id: "s1", action: "click", selector: "#title" },
        { id: "s2", action: "click", selector: "#save-post" },
      ],
    },
  };

  const makeWebContents = (visibleWpAuthCheck: boolean) =>
    ({
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        if (script === HUMAN_REQUIRED_DETECTION_SCRIPT) {
          const { self, styles } = makeWpAuthCheckNode(
            visibleWpAuthCheck
              ? { wrapHiddenClass: false, wrapDisplay: "block", rect: { width: 380, height: 420 } }
              : { wrapHiddenClass: true, wrapDisplay: "none", rect: { width: 0, height: 0 } }
          );
          return evalDetectionScript({
            matchedSelectors: { "#wp-auth-check": self },
            computedStyles: styles,
          });
        }
        return true;
      },
    }) as never;

  const account = {
    accountId: "acc-1",
    siteUrl: "https://maytuicanvas.com",
    getPassword: async () => "",
  };
  const runner = new AuthScriptRunner();
  const okOutcome = await runner.run({
    webContents: makeWebContents(false),
    release,
    account,
    accountId: "acc-1",
  });
  assert.equal(okOutcome.kind, "ok");
  assert.equal(okOutcome.stepsExecuted, 2);

  const humanOutcome = await runner.run({
    webContents: makeWebContents(true),
    release,
    account,
    accountId: "acc-1",
  });
  assert.equal(humanOutcome.kind, "human_required");
  assert.equal(humanOutcome.stepsExecuted, 1);
});
