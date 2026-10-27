import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProfilesForSync } from "../src/main/browser/browser-sync-service.js";
import type { BrowserProfile } from "../src/shared/contracts.js";

test("BrowserSync: formats target metadata schema and strictly omits forbidden fields", () => {
  const profiles: BrowserProfile[] = [
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331001",
      name: "Facebook Profile 1",
      platform: "facebook",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331001",
      status: "running",
      accountBinding: {
        accountId: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
        boundAt: "2026-10-26T12:00:00Z",
        accountName: "test 1",
      },
      sessionSignal: {
        status: "present",
        checkedAt: "2026-10-26T12:05:00Z",
        method: "facebook_c_user_cookie",
      },
      executionConfirmation: {
        status: "not_run",
        firstRunAt: null,
        lastSuccessAt: null,
        lastRunId: null,
        screenshotRef: null,
      },
      lastUrl: "https://www.facebook.com",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331002",
      name: "Facebook Profile 2",
      platform: "facebook",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331002",
      status: "stopped",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331003",
      name: "Generic Site Profile",
      platform: "general",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331003",
      status: "stopped",
      sessionSignal: {
        status: "present",
        checkedAt: "2026-10-26T12:10:00Z",
        method: "site_cookie_presence",
      },
      lastUrl: "https://example.org",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331004",
      name: "Existing Account Without Signal",
      platform: "facebook",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331004",
      status: "stopped",
      accountBinding: {
        accountId: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f84",
        boundAt: "2026-10-26T12:00:00Z",
        accountName: "No signal",
      },
      sessionSignal: { status: "unknown", checkedAt: null, method: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331005",
      name: "Account With Absent Signal",
      platform: "facebook",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331005",
      status: "stopped",
      accountBinding: {
        accountId: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f85",
        boundAt: "2026-10-26T12:00:00Z",
        accountName: "Absent signal",
      },
      sessionSignal: { status: "absent", checkedAt: "2026-10-26T12:15:00Z", method: "facebook_c_user_cookie" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const sanitized = sanitizeProfilesForSync(profiles);

  assert.equal(sanitized.length, 2, "unchecked profiles stay local while changed absent signals are eligible for sync");
  assert.equal(sanitized[1].session_signal.status, "absent");

  // Target schema verification for profile 1
  assert.equal(sanitized[0].browser_id, "b3f36077-9ca6-4d26-a94f-a7f45b331001");
  assert.equal(sanitized[0].name, "Facebook Profile 1");
  assert.equal(sanitized[0].platform, "facebook");
  assert.equal(sanitized[0].status, "running");
  assert.deepEqual(sanitized[0].runtime, { status: "running" });
  assert.deepEqual(sanitized[0].account_binding, {
    account_id: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
    bound_at: "2026-10-26T12:00:00Z",
    account_name: "test 1",
  });
  assert.deepEqual(sanitized[0].session_signal, {
    status: "present",
    checked_at: "2026-10-26T12:05:00Z",
    method: "facebook_c_user_cookie",
  });
  assert.deepEqual(sanitized[0].execution_confirmation, {
    status: "not_run",
    first_run_at: null,
    last_success_at: null,
    last_run_id: null,
    screenshot_ref: null,
  });

  // Verify none of forbidden keys exist anywhere in payload
  const forbiddenKeys = [
    "cookies",
    "cookie",
    "password",
    "passwords",
    "token",
    "secret",
    "profile_path",
    "user_data_dir",
    "c_user",
    "cookie_value",
    "partition",
  ];

  for (const item of sanitized) {
    for (const forbidden of forbiddenKeys) {
      assert.equal(
        forbidden in item,
        false,
        `Sanitized sync item must never contain forbidden field: ${forbidden}`
      );
    }
  }
});
