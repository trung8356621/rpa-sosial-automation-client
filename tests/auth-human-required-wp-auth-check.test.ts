import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  AuthScriptRunner,
  HUMAN_REQUIRED_DETECTION_SCRIPT,
  type HumanRequiredDetectionResult,
} from "../src/main/auth/auth-script-runner.js";
import type { AuthReleasePulled } from "../src/main/auth/auth-script-types.js";
import { setLogListener } from "../src/main/main-error-log.js";

type MockNode = {
  tagName?: string;
  open?: boolean;
  isConnected?: boolean;
  innerText?: string;
  textContent?: string;
  parentElement?: MockNode | null;
  classList?: { contains: (cls: string) => boolean };
  hasAttribute?: (attr: string) => boolean;
  getAttribute?: (attr: string) => string | null;
  closest?: (sel: string) => MockNode | null;
  getBoundingClientRect?: () => { width: number; height: number };
};

function makeNode(opts: {
  tagName?: string;
  open?: boolean;
  isConnected?: boolean;
  classes?: string[];
  attrs?: Record<string, string>;
  rect?: { width: number; height: number };
  innerText?: string;
  parentElement?: MockNode | null;
  closestMap?: Record<string, MockNode | null>;
} = {}): MockNode {
  const classes = new Set(opts.classes ?? []);
  const attrs = opts.attrs ?? {};
  return {
    tagName: opts.tagName ?? "DIV",
    open: opts.open,
    isConnected: opts.isConnected ?? true,
    innerText: opts.innerText ?? "",
    textContent: opts.innerText ?? "",
    parentElement: opts.parentElement ?? null,
    classList: { contains: (c: string) => classes.has(c) },
    hasAttribute: (a: string) => Object.prototype.hasOwnProperty.call(attrs, a),
    getAttribute: (a: string) => (Object.prototype.hasOwnProperty.call(attrs, a) ? attrs[a] : null),
    closest: (sel: string) => {
      if (opts.closestMap && sel in opts.closestMap) return opts.closestMap[sel];
      return null;
    },
    getBoundingClientRect: () => opts.rect ?? { width: 300, height: 80 },
  };
}

function evalDetection(opts: {
  bodyText?: string;
  matchedAll?: Record<string, MockNode[]>;
  matchedSingle?: Record<string, MockNode | null>;
  computedStyles?: Map<MockNode, { display?: string; visibility?: string; opacity?: string }>;
}): HumanRequiredDetectionResult {
  const matchedAll = opts.matchedAll ?? {};
  const matchedSingle = opts.matchedSingle ?? {};
  const styles = opts.computedStyles ?? new Map();
  const context = {
    document: {
      body: { innerText: opts.bodyText ?? "" },
      querySelectorAll: (sel: string) => matchedAll[sel] ?? (matchedSingle[sel] ? [matchedSingle[sel]!] : []),
      querySelector: (sel: string) => matchedSingle[sel] ?? matchedAll[sel]?.[0] ?? null,
    },
    window: {
      getComputedStyle: (el: MockNode) => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        ...(styles.get(el) ?? {}),
      }),
    },
  };
  return vm.runInNewContext(HUMAN_REQUIRED_DETECTION_SCRIPT, context) as HumanRequiredDetectionResult;
}

test("1. Hidden WordPress #wp-auth-check -> NONE", () => {
  const wrap = makeNode({ classes: ["hidden"] });
  const wpAuth = makeNode({
    parentElement: wrap,
    rect: { width: 0, height: 0 },
    closestMap: { "#wp-auth-check-wrap": wrap },
  });
  const styles = new Map([[wrap, { display: "none" }]]);
  const res = evalDetection({
    bodyText: "Add Post TEST Mock Title #5",
    matchedAll: { "#wp-auth-check": [wpAuth] },
    computedStyles: styles,
  });
  assert.equal(res.outcome, "NONE");
});

test("2. Visible WordPress #wp-auth-check dialog -> CONFIRMED", () => {
  const wrap = makeNode({ classes: [] });
  const wpAuth = makeNode({
    parentElement: wrap,
    rect: { width: 380, height: 420 },
    closestMap: { "#wp-auth-check-wrap": wrap },
  });
  const styles = new Map([[wrap, { display: "block" }]]);
  const res = evalDetection({
    matchedAll: { "#wp-auth-check": [wpAuth] },
    computedStyles: styles,
  });
  assert.equal(res.outcome, "CONFIRMED");
  assert.equal(res.ruleId, "wp_auth_check_visible");
});

test("3. Hidden CAPTCHA widget (display:none / aria-hidden / 0x0 / disconnected) -> NONE", () => {
  const hiddenByCss = makeNode({ rect: { width: 304, height: 78 } });
  const hiddenByAria = makeNode({ attrs: { "aria-hidden": "true" }, rect: { width: 304, height: 78 } });
  const hiddenBySize = makeNode({ rect: { width: 0, height: 0 } });
  const disconnected = makeNode({ isConnected: false, rect: { width: 304, height: 78 } });
  const styles = new Map([[hiddenByCss, { display: "none" }]]);

  const res = evalDetection({
    matchedAll: {
      ".g-recaptcha": [hiddenByCss, hiddenByAria, hiddenBySize, disconnected],
    },
    computedStyles: styles,
  });
  assert.equal(res.outcome, "NONE");
});

test("4. Visible active CAPTCHA challenge -> CONFIRMED", () => {
  const recaptcha = makeNode({ rect: { width: 304, height: 78 } });
  const res = evalDetection({
    matchedAll: { ".g-recaptcha": [recaptcha] },
  });
  assert.equal(res.outcome, "CONFIRMED");
  assert.equal(res.ruleId, "captcha_or_verification_ui");
});

test("5. Generic verify/captcha text in a WordPress admin notice -> NONE (not CONFIRMED)", () => {
  const wpAdminBar = makeNode({});
  const res = evalDetection({
    bodyText: "Please verify your plugin settings. reCAPTCHA plugin update available.",
    matchedSingle: { "#wpadminbar": wpAdminBar },
  });
  assert.equal(res.outcome, "NONE");
});

test("6. Inactive/hidden modal (<dialog> not open, aria-hidden dialog) -> NONE", () => {
  const closedDialog = makeNode({
    tagName: "DIALOG",
    open: false,
    innerText: "Please verify you are human",
    rect: { width: 400, height: 300 },
  });
  const ariaHiddenDialog = makeNode({
    attrs: { "aria-hidden": "true" },
    innerText: "Security check: verify you are human",
    rect: { width: 400, height: 300 },
  });
  const res = evalDetection({
    matchedAll: {
      "dialog[open]": [],
      '[role="dialog"]': [closedDialog, ariaHiddenDialog],
    },
  });
  assert.equal(res.outcome, "NONE");
});

test("7. Weak ambiguous signal -> UNCERTAIN, logs warning only, execution continues", async () => {
  const events: Array<{ level: string; message: string }> = [];
  setLogListener((entry) => events.push({ level: entry.level, message: entry.message }));
  try {
    const release: AuthReleasePulled = {
      action_tag_id: 1,
      action_tag_key: "maytuicanvas.create_post",
      package_key: "pkg-1",
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
        script_id: "pkg-1",
        variables: [],
        steps: [
          { id: "s1", action: "click", selector: "#title" },
          { id: "s2", action: "click", selector: "#save-post" },
        ],
      },
    };
    const webContents = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        if (script === HUMAN_REQUIRED_DETECTION_SCRIPT) {
          return evalDetection({
            bodyText: "This page mentions captcha in passing without any widget",
          });
        }
        return true;
      },
    } as never;

    const runner = new AuthScriptRunner();
    const out = await runner.run({
      webContents,
      release,
      account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" },
      accountId: "acc-1",
      jobId: "job-uncertain-1",
      attemptId: "att-uncertain-1",
    });

    assert.equal(out.kind, "ok");
    assert.equal(out.stepsExecuted, 2);
    const detLogs = events.filter((e) => e.message.includes("HUMAN_REQUIRED_DETECTION"));
    assert.equal(detLogs.length, 2);
    assert.ok(detLogs[0].message.includes('"outcome":"UNCERTAIN"'));
    assert.ok(detLogs[0].message.includes('"blocked":false'));
    assert.ok(detLogs[0].message.includes('"jobId":"job-uncertain-1"'));
  } finally {
    setLogListener(null);
  }
});

test("8 & 9 & 10. Normal Step 1 -> Step 2 continues when hidden; legitimate verification stops with accurate partial state", async () => {
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
  const account = {
    accountId: "acc-1",
    siteUrl: "https://maytuicanvas.com",
    getPassword: async () => "",
  };

  const makeWebContents = (visibleChallenge: boolean) =>
    ({
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        if (script === HUMAN_REQUIRED_DETECTION_SCRIPT) {
          if (!visibleChallenge) {
            const wrap = makeNode({ classes: ["hidden"] });
            const wpAuth = makeNode({ parentElement: wrap, rect: { width: 0, height: 0 } });
            return evalDetection({
              matchedAll: { "#wp-auth-check": [wpAuth] },
              computedStyles: new Map([[wrap, { display: "none" }]]),
            });
          }
          const challenge = makeNode({ rect: { width: 320, height: 240 } });
          return evalDetection({
            matchedAll: { ".cf-challenge": [challenge] },
          });
        }
        return true;
      },
    }) as never;

  const runner = new AuthScriptRunner();
  const okOutcome = await runner.run({
    webContents: makeWebContents(false),
    release,
    account,
    accountId: "acc-1",
  });
  assert.equal(okOutcome.kind, "ok");
  assert.equal(okOutcome.stepsExecuted, 2);

  const blockedOutcome = await runner.run({
    webContents: makeWebContents(true),
    release,
    account,
    accountId: "acc-1",
    jobId: "job-confirmed-1",
    attemptId: "att-confirmed-1",
  });
  assert.equal(blockedOutcome.kind, "human_required");
  assert.equal(blockedOutcome.stepsExecuted, 1);
});
