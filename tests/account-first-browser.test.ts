import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfileManager } from "../src/main/browser/profile-manager.js";
import { resolveInitialUrl, detectBrowserTagFromUrl, isDomainMatchingAccount } from "../src/main/browser/url-resolver.js";
import { sanitizeProfilesForSync } from "../src/main/browser/browser-sync-service.js";
import { sanitizeLog } from "../src/main/main-error-log.js";
import type { AccountInfo } from "../src/shared/contracts.js";

test("A. Không thể tạo Browser nếu chưa chọn Account", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-a-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    await assert.rejects(
      async () => await pm.createForAccount(null as unknown as AccountInfo),
      /Không thể tạo Browser nếu chưa chọn Account/
    );

    await assert.rejects(
      async () => await pm.createForAccount({} as unknown as AccountInfo),
      /Không thể tạo Browser nếu chưa chọn Account/
    );

    await assert.rejects(
      async () =>
        await pm.createForAccount({
          accountId: "",
          displayName: "Empty ID",
          platform: "facebook",
          email: "user@test.com",
        } as AccountInfo),
      /Không thể tạo Browser nếu chưa chọn Account/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("B. Account thiếu Email bị từ chối", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-b-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    await assert.rejects(
      async () =>
        await pm.createForAccount({
          accountId: "acc-no-email-1",
          displayName: "No Email Account",
          platform: "facebook",
          email: null,
          username: null,
          identityLabel: null,
          verified: false,
        }),
      /Thiếu Email/
    );

    await assert.rejects(
      async () =>
        await pm.createForAccount({
          accountId: "acc-no-email-2",
          displayName: "Whitespace Email Account",
          platform: "facebook",
          email: "   ",
          username: null,
          identityLabel: null,
          verified: false,
        }),
      /Thiếu Email/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("C. Account có Email nhưng Password trống vẫn được chọn", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-c-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const created = await pm.createForAccount({
      accountId: "acc-no-pass",
      displayName: "No Password Account",
      platform: "facebook",
      email: "valid@facebook.com",
      hasPassword: false,
      username: "valid_fb",
      identityLabel: null,
      verified: false,
    });

    assert.equal(created.alreadyExists, false);
    assert.ok(created.profile.browserId);
    assert.equal(created.profile.name, "No Password Account");
    assert.equal(created.profile.accountBinding?.email, "valid@facebook.com");
    assert.equal(created.profile.accountBinding?.accountId, "acc-no-pass");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("D. Auto Profile Name + Platform từ Account", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-d-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const res = await pm.createForAccount({
      accountId: "acc-seo-ops-99",
      displayName: "Fanpage Seeding 2026",
      platform: "Threads",
      email: "threads_seeding@meta.com",
      username: "fanpage_seeding",
      identityLabel: null,
      verified: true,
    });

    assert.equal(res.profile.name, "Fanpage Seeding 2026");
    assert.equal(res.profile.platform, "threads");
    assert.equal(res.profile.accountBinding?.accountId, "acc-seo-ops-99");
    assert.equal(res.profile.accountBinding?.accountName, "Fanpage Seeding 2026");
    assert.equal(res.profile.partition, `persist:rpa-client-${res.profile.browserId}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("E. Chọn lại Account không tạo Browser trùng trên cùng thiết bị", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-e-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    const acc: AccountInfo = {
      accountId: "acc-unique-singleton",
      displayName: "Singleton Account",
      platform: "instagram",
      email: "singleton@ig.com",
      username: "singleton_ig",
      identityLabel: null,
      verified: true,
    };

    const first = await pm.createForAccount(acc);
    assert.equal(first.alreadyExists, false);
    assert.equal(pm.list().length, 1);

    // Second creation attempt with same Account ID
    const second = await pm.createForAccount(acc);
    assert.equal(second.alreadyExists, true);
    assert.equal(second.profile.browserId, first.profile.browserId);
    assert.equal(pm.list().length, 1, "Must not create duplicate profile");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("F. Auto open URL theo Platform", () => {
  assert.equal(resolveInitialUrl("facebook"), "https://www.facebook.com");
  assert.equal(resolveInitialUrl("FB"), "https://www.facebook.com");
  assert.equal(resolveInitialUrl("threads"), "https://www.threads.net");
  assert.equal(resolveInitialUrl("instagram"), "https://www.instagram.com");
  assert.equal(resolveInitialUrl("ig"), "https://www.instagram.com");
  assert.equal(resolveInitialUrl("x"), "https://x.com");
  assert.equal(resolveInitialUrl("tiktok"), "https://www.tiktok.com");
});

test("G. WordPress custom Site URL (bao gồm subdirectory)", () => {
  assert.equal(
    resolveInitialUrl("wordpress", "https://example.com/tech-blog"),
    "https://example.com/tech-blog"
  );
  assert.equal(
    resolveInitialUrl("wp", "http://intranet.company.local/subfolder/wp-admin"),
    "http://intranet.company.local/subfolder/wp-admin"
  );
  assert.equal(
    resolveInitialUrl("custom", "portal.domain.com/landing"),
    "https://portal.domain.com/landing"
  );
});

test("H. Không tự fallback sang Facebook/general.com", () => {
  // WordPress without siteUrl must throw error, never fallback to facebook or general.com
  assert.throws(
    () => resolveInitialUrl("wordpress", ""),
    /yêu cầu cấu hình Site URL trên SEO-OPS/
  );
  assert.throws(
    () => resolveInitialUrl("wordpress", null),
    /yêu cầu cấu hình Site URL trên SEO-OPS/
  );

  // Custom platform without siteUrl must throw error
  assert.throws(
    () => resolveInitialUrl("custom", ""),
    /yêu cầu cấu hình Site URL trên SEO-OPS/
  );

  // Unknown platform without siteUrl must throw error
  assert.throws(
    () => resolveInitialUrl("linkedin", null),
    /Không xác định được URL cho nền tảng "linkedin"/
  );
});

test("I. Profile/session cũ không bị mất sau cập nhật", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-i-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    // Create legacy style profile
    const p1 = await pm.create("Legacy Profile 01", "facebook", {accountId:"legacy-acc-123",boundAt:new Date().toISOString(),accountName:"Legacy Account",email:"legacy@fb.com"});
    await pm.recordUrl(p1.browserId, "https://www.facebook.com/messages");

    // Reload with fresh ProfileManager instance
    const pm2 = new ProfileManager(tmpDir);
    await pm2.initialize();

    const loaded = pm2.get(p1.browserId);
    assert.ok(loaded);
    assert.equal(loaded?.browserId, p1.browserId);
    // Display identity is Account Name (Browser Name is not a business field).
    assert.equal(loaded?.accountBinding?.accountName || loaded?.name, "Legacy Account");
    assert.equal(loaded?.partition, p1.partition);
    assert.equal(loaded?.accountBinding?.accountId, "legacy-acc-123");
    assert.equal(loaded?.accountBinding?.email, "legacy@fb.com");
    assert.equal(loaded?.lastUrl, "https://www.facebook.com/messages");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("J. Account change bị chặn để không dùng lại session của Account khác", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-j-"));
  try {
    let sessionResetFired = false;
    let wipedPartition = "";

    const pm = new ProfileManager(tmpDir);
    pm.setSessionResetCallback(async (_browserId, partition) => {
      sessionResetFired = true;
      wipedPartition = partition;
    });
    await pm.initialize();

    const p = await pm.create("Multi Account Profile", "facebook", {accountId:"acc-A",boundAt:new Date().toISOString(),accountName:"Account Alpha",email:"alpha@fb.com"});
    await pm.updateSessionSignal(p.browserId, {
      status: "present",
      checkedAt: "2026-10-26T12:00:00Z",
      method: "facebook_c_user_cookie",
    });

    p.executionConfirmation = {
      status: "confirmed",
      firstRunAt: "2026-10-26T12:00:00Z",
      lastSuccessAt: "2026-10-26T12:05:00Z",
      lastRunId: "run_alpha",
      screenshotRef: null,
    };

    // Switch Account Alpha -> Account Beta
    await assert.rejects(pm.bindAccount(p.browserId, "acc-B", "Account Beta", "beta@fb.com"), /bất biến/);
    assert.equal(pm.get(p.browserId)?.accountBinding?.accountId, "acc-A");
    assert.equal(sessionResetFired, false);
    assert.equal(wipedPartition, "");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("K. Facebook c_user và generic fallback không regression", () => {
  assert.equal(detectBrowserTagFromUrl("https://www.facebook.com/groups/123"), "facebook");
  assert.equal(detectBrowserTagFromUrl("https://m.facebook.com/home.php"), "facebook");
  assert.equal(detectBrowserTagFromUrl("https://www.threads.net/@user"), "threads");
  assert.equal(detectBrowserTagFromUrl("https://www.instagram.com/p/abc"), "instagram");
  assert.equal(detectBrowserTagFromUrl("https://my-blog.com/blog/wp-login.php"), "my-blog.com");
});

test("L. Không lộ Password trong API list, Profile JSON hoặc logs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-l-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    await pm.createForAccount({
      accountId: "acc-safe",
      displayName: "Safe Profile",
      platform: "facebook",
      email: "safe@example.com",
      username: "safe_user",
      identityLabel: null,
      verified: true,
    });

    const fileContent = await readFile(path.join(tmpDir, "browser-profiles.json"), "utf-8");
    assert.equal(fileContent.includes("password"), false, "Profile JSON must never contain password field");
    assert.equal(fileContent.includes("encrypted_password"), false);

    // Browser sync payload must strictly omit secrets
    const syncPayload = sanitizeProfilesForSync(pm.list());
    const syncString = JSON.stringify(syncPayload);
    assert.equal(syncString.includes("password"), false);
    assert.equal(syncString.includes("secret"), false);

    // Log sanitization check
    const rawSecret = "UserPlaintextPassword123!";
    const testLog = `Attempted login with pass: ${rawSecret} Bearer rpa_secret_key_12345`;
    const sanitized = sanitizeLog(testLog);
    assert.equal(sanitized.includes("rpa_secret_key_12345"), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("M. isDomainMatchingAccount checks domain vs account platform / siteUrl", () => {
  // WordPress with siteUrl
  assert.equal(
    isDomainMatchingAccount("wordpress", "https://mayhopphat.com/wp-login.php", "https://mayhopphat.com/wp-admin"),
    true
  );
  assert.equal(
    isDomainMatchingAccount("wordpress", "https://mayhopphat.com/wp-login.php", "https://facebook.com"),
    false
  );

  // Facebook
  assert.equal(
    isDomainMatchingAccount("facebook", undefined, "https://www.facebook.com/groups/123"),
    true
  );
  assert.equal(
    isDomainMatchingAccount("facebook", undefined, "https://m.facebook.com"),
    true
  );
  assert.equal(
    isDomainMatchingAccount("facebook", undefined, "https://google.com"),
    false
  );

  // Threads
  assert.equal(
    isDomainMatchingAccount("threads", undefined, "https://www.threads.net"),
    true
  );
  assert.equal(
    isDomainMatchingAccount("threads", undefined, "https://threads.com"),
    false
  );
});

test("N. bindAccount cannot change profile platform/account", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-test-n-"));
  try {
    const pm = new ProfileManager(tmpDir);
    await pm.initialize();

    // Create a profile originally on facebook
    const created = await pm.createForAccount({
      accountId: "acc-old-fb",
      displayName: "Old FB Profile",
      platform: "facebook",
      email: "fb@meta.com",
      username: "fb_user",
      identityLabel: null,
      verified: true,
    });
    assert.equal(created.profile.platform, "facebook");

    // Rebind to a WordPress account with platform passed
    await assert.rejects(pm.bindAccount(
      created.profile.browserId,
      "acc-new-wp",
      "test WP",
      "wp_user@mayhopphat.com",
      "https://mayhopphat.com/wp-login.php",
      "wordpress"
    ), /bất biến/);
    assert.equal(pm.get(created.profile.browserId)?.platform, "facebook");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("O. detectBrowserTagFromUrl extracts proper tags without altering account", () => {
  assert.equal(detectBrowserTagFromUrl("https://mayhopphat.com/wp-login.php"), "mayhopphat.com");
  assert.equal(detectBrowserTagFromUrl("https://sub.domain.com/path"), "sub.domain.com");
  assert.equal(detectBrowserTagFromUrl("https://www.instagram.com"), "instagram");
  assert.equal(detectBrowserTagFromUrl("about:blank"), "unknown");
});
