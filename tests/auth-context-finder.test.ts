import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthContextFinder,
  parseAuthContextResponse,
} from "../src/main/auth/auth-context-finder.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

function mockConnection(handler: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return {
    isOnline: () => true,
    getConnectionToken: () => "lease-token-test",
    requestWithAuth: async (path: string, _method: string, body?: Record<string, unknown>) =>
      handler(path, body),
  };
}

test("auth/context 0 eligible → none (manual login)", async () => {
  const finder = new AuthContextFinder(
    mockConnection(async () => ({ ok: true, match: "none", count: 0 }))
  );
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "none");
  if (out.kind === "none") assert.equal(out.count, 0);
});

test("auth/context 1 eligible → unique tag", async () => {
  const finder = new AuthContextFinder(
    mockConnection(async (path, body) => {
      assert.match(path, /\/client\/auth\/context$/);
      assert.equal(body?.account_id, "acc-1");
      assert.equal(body?.connection_token, "lease-token-test");
      return {
        ok: true,
        match: "unique",
        count: 1,
        action_tag_id: 42,
        action_tag_key: "mayhopphat.login",
      };
    })
  );
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "unique");
  if (out.kind === "unique") {
    assert.equal(out.tag.actionTagId, 42);
    assert.equal(out.tag.actionTagKey, "mayhopphat.login");
  }
});

test("auth/context N eligible → ambiguous (no arbitrary pick)", async () => {
  const finder = new AuthContextFinder(
    mockConnection(async () => ({
      ok: true,
      match: "ambiguous",
      count: 2,
      candidates: [
        { action_tag_id: 1, action_tag_key: "mayhopphat.login" },
        { action_tag_id: 2, action_tag_key: "mayhopphat.login_alt" },
      ],
    }))
  );
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "ambiguous");
  if (out.kind === "ambiguous") {
    assert.equal(out.count, 2);
    assert.equal(out.candidates.length, 2);
  }
});

test("auth/context unauthorized → NO_ACCOUNT_TAG_ENTITLEMENT / mapped error", async () => {
  const finder = new AuthContextFinder(
    mockConnection(async () => {
      throw new SeoOpsHttpError({
        method: "POST",
        endpoint: "/api/v1/social-automation/client/auth/context",
        status: 403,
        contentType: "application/json",
        category: "authorization",
        serverErrorCode: "installation_forbidden",
        serverErrorMessage: "forbidden",
      });
    })
  );
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.equal(out.code, "NO_ACCOUNT_TAG_ENTITLEMENT");
  }
});

test("auth/context offline → CLIENT_LEASE_INVALID", async () => {
  const finder = new AuthContextFinder({
    isOnline: () => false,
    getConnectionToken: () => null,
    requestWithAuth: async () => {
      throw new Error("must not call");
    },
  });
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "error");
  if (out.kind === "error") assert.equal(out.code, "CLIENT_LEASE_INVALID");
});

test("auth/context endpoint error → AUTH_CONTEXT_UNAVAILABLE / mapped", async () => {
  const finder = new AuthContextFinder(
    mockConnection(async () => {
      throw new SeoOpsHttpError({
        method: "POST",
        endpoint: "/api/v1/social-automation/client/auth/context",
        status: 404,
        contentType: "application/json",
        category: "unexpected_response",
        serverErrorCode: "auth_context_unavailable",
        serverErrorMessage: "missing",
      });
    })
  );
  const out = await finder.findForAccount("acc-1");
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.equal(out.code, "AUTH_CONTEXT_UNAVAILABLE");
  }
});

test("parseAuthContextResponse rejects unique without tag identity", () => {
  const out = parseAuthContextResponse({ ok: true, match: "unique", count: 1 }, "acc");
  assert.equal(out.kind, "error");
});

test("parseAuthContextResponse does not invent platform.login", () => {
  const out = parseAuthContextResponse({ ok: true, match: "none", count: 0 }, "acc");
  assert.equal(out.kind, "none");
  assert.ok(!JSON.stringify(out).includes(".login"));
});
