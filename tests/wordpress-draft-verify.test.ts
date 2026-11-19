import assert from "node:assert/strict";
import test from "node:test";
import { verifyWordPressDraft } from "../src/main/jobs/wordpress-draft-verify.js";

test("verifyWordPressDraft fails closed without expected title", async () => {
  const out = await verifyWordPressDraft({
    webContents: {
      getURL: () => "https://mayhopphat.com/wp-admin/post-new.php",
      executeJavaScript: async () => {
        throw new Error("should not run");
      },
    } as never,
    title: "  ",
  });
  assert.equal(out.verified, false);
  assert.equal(out.evidence, "missing_expected_title");
});

test("verifyWordPressDraft requires title match AND draft UI hint", async () => {
  const out = await verifyWordPressDraft({
    webContents: {
      getURL: () => "https://mayhopphat.com/wp-admin/post.php?post=12&action=edit",
      executeJavaScript: async () => ({
        titleMatched: true,
        draftStatusHint: true,
        bodySnippet: "CP19 Draft Title",
      }),
    } as never,
    title: "CP19 Draft Title",
  });
  assert.equal(out.verified, true);
  assert.equal(out.titleMatched, true);
  assert.equal(out.evidence, "title_and_draft_ui");
});

test("verifyWordPressDraft rejects title-only without draft evidence", async () => {
  const out = await verifyWordPressDraft({
    webContents: {
      getURL: () => "https://mayhopphat.com/",
      executeJavaScript: async () => ({
        titleMatched: true,
        draftStatusHint: false,
        bodySnippet: "CP19 Draft Title",
      }),
    } as never,
    title: "CP19 Draft Title",
  });
  assert.equal(out.verified, false);
  assert.match(out.evidence, /unverified/);
});
