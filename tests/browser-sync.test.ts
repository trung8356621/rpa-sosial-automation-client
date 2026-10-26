import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProfilesForSync } from "../src/main/browser/browser-sync-service.js";
import type { BrowserProfile } from "../src/shared/contracts.js";

test("BrowserSync: strictly sanitizes payload and contains zero forbidden fields", () => {
  const profiles: BrowserProfile[] = [
    {
      browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331001",
      name: "Facebook Profile 1",
      platform: "facebook",
      partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331001",
      status: "running",
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
  ];

  const sanitized = sanitizeProfilesForSync(profiles);

  assert.equal(sanitized.length, 2);
  assert.deepEqual(sanitized[0], {
    browser_id: "b3f36077-9ca6-4d26-a94f-a7f45b331001",
    name: "Facebook Profile 1",
    platform: "facebook",
    status: "running",
  });

  // Verify none of forbidden keys exist
  const forbiddenKeys = [
    "cookies",
    "cookie",
    "password",
    "passwords",
    "token",
    "secret",
    "profile_path",
    "user_data_dir",
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
