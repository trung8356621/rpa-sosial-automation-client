import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { AuthScriptRunner } from "../src/main/auth/auth-script-runner.js";
import {
  HUMAN_REQUIRED_DETECTION_SCRIPT,
  type HumanRequiredDetectionResult,
} from "../src/main/auth/human-required-detector.js";
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

function evalIsolatedDetector(opts: {
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

function twoStepRelease(): AuthReleasePulled {
  return {
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
}

test("1. AuthScriptRunner proceeds from Step 1 to Step 2 without running DOM detectHumanRequired", async () => {
  const executedScripts: string[] = [];
  const logMessages: string[] = [];
  setLogListener((entry) => logMessages.push(entry.message));
  try {
    const webContents = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        executedScripts.push(script);
        // Would have matched #wp-auth-check or .cf-challenge if detector ran.
        assert.notEqual(script, HUMAN_REQUIRED_DETECTION_SCRIPT);
        return true;
      },
    } as never;

    const runner = new AuthScriptRunner();
    const out = await runner.run({
      webContents,
      release: twoStepRelease(),
      account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" },
      accountId: "acc-1",
      jobId: "job-1",
      attemptId: "att-1",
    });

    assert.equal(out.kind, "ok");
    assert.equal(out.stepsExecuted, 2);
    // Each DOM click step runs waitForSelector + click (2 calls per step = 4 total) — zero detector calls.
    assert.equal(executedScripts.length, 4);
    assert.equal(logMessages.some((m) => m.includes("HUMAN_REQUIRED_DETECTION")), false);
  } finally {
    setLogListener(null);
  }
});

test("2. Explicit Step 2 failure after Step 1 still stops execution with accurate stepsExecuted", async () => {
  let jsCalls = 0;
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => {
      jsCalls += 1;
      // Step 1 executes 2 JS calls (waitForSelector + click); fail on Step 2's first JS call.
      if (jsCalls <= 2) return true;
      throw new Error("Step 2 target element not found");
    },
  } as never;

  const runner = new AuthScriptRunner();
  const out = await runner.run({
    webContents,
    release: twoStepRelease(),
    account: { accountId: "acc-1", siteUrl: "https://maytuicanvas.com", getPassword: async () => "" },
    accountId: "acc-1",
  });

  assert.equal(out.kind, "error");
  assert.equal(out.stepsExecuted, 1);
  assert.match(out.message, /Step 2 target element not found/);
});

test("3. Isolated detector module remains intact for future opt-in use", () => {
  const wrapHidden = makeNode({ classes: ["hidden"] });
  const wpAuthHidden = makeNode({
    parentElement: wrapHidden,
    rect: { width: 0, height: 0 },
    closestMap: { "#wp-auth-check-wrap": wrapHidden },
  });
  const hiddenRes = evalIsolatedDetector({
    matchedAll: { "#wp-auth-check": [wpAuthHidden] },
    computedStyles: new Map([[wrapHidden, { display: "none" }]]),
  });
  assert.equal(hiddenRes.outcome, "NONE");

  const visibleChallenge = makeNode({ rect: { width: 320, height: 240 } });
  const confirmedRes = evalIsolatedDetector({
    matchedAll: { ".cf-challenge": [visibleChallenge] },
  });
  assert.equal(confirmedRes.outcome, "CONFIRMED");
});
