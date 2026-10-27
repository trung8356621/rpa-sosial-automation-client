import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSessionCookies, resolveSessionStrategy } from "../src/main/browser/session-signal-strategy.js";

test("strategy follows the actual website instead of stale account platform", () => {
  assert.equal(resolveSessionStrategy("https://mayhopphat.com/wp-admin/", "https://mayhopphat.com/"), "wordpress");
  assert.equal(resolveSessionStrategy("https://www.facebook.com/", "https://mayhopphat.com/"), "facebook");
  assert.equal(resolveSessionStrategy("https://example.org/", null), "unsupported");
});

test("WordPress detection supports auth cookie prefixes and subdirectory installs", () => {
  assert.equal(resolveSessionStrategy("https://example.com/blog/wp-admin/", "https://example.com/blog/"), "wordpress");
  assert.equal(evaluateSessionCookies("wordpress", [{ name: "wordpress_logged_in_abcd" }], "now").status, "present");
  assert.equal(evaluateSessionCookies("wordpress", [{ name: "wordpress_sec_abcd" }], "now").status, "present");
  assert.equal(evaluateSessionCookies("wordpress", [{ name: "wordpress_test_cookie" }], "now").status, "absent");
});

test("Facebook, unsupported and logout states stay distinct", () => {
  assert.equal(evaluateSessionCookies("facebook", [{ name: "c_user" }], "now").status, "present");
  assert.equal(evaluateSessionCookies("facebook", [], "now").status, "absent");
  assert.equal(evaluateSessionCookies("unsupported", [], "now").status, "unsupported");
});
