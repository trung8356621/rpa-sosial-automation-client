import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSyncService, formatConfirmLoginFailure } from "../src/main/browser/browser-sync-service.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

function makeProfile(checkedAt: string) {
  return {
    browserId: "b3f36077-9ca6-4d26-a94f-a7f45b331001",
    name: "Facebook Profile 1",
    platform: "facebook",
    partition: "persist:rpa-client-b3f36077-9ca6-4d26-a94f-a7f45b331001",
    status: "stopped" as const,
    accountBinding: {
      accountId: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
      boundAt: "2026-10-26T12:00:00Z",
      accountName: "test 1",
    },
    sessionSignal: {
      status: "present" as const,
      checkedAt,
      method: "facebook_c_user_cookie" as const,
    },
    createdAt: "2026-10-26T12:00:00Z",
    updatedAt: "2026-10-26T12:00:00Z",
  };
}

test("concurrent syncAll awaits the newest successful snapshot", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const uploadedCheckedAt: string[] = [];
  let signalCheckedAt = "2026-10-26T12:00:01.000Z";

  const connection = {
    onStateChange: () => () => undefined,
    isOnline: () => true,
    requestWithAuth: async (path: string, _method: string, body?: Record<string, unknown>) => {
      if (path.includes("/accounts/")) {
        return {
          ok: true,
          account: {
            account_id: "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
            platform: "facebook",
            display_name: "test 1",
            email: null,
            password_status: "unavailable",
          },
        };
      }
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const browsers = (body?.browsers as Array<{ session_signal?: { checked_at?: string } }>) || [];
      uploadedCheckedAt.push(String(browsers[0]?.session_signal?.checked_at || ""));
      inFlight -= 1;
      return { ok: true, browsers: [] };
    },
  };

  const profiles = {
    list: () => [makeProfile(signalCheckedAt)],
    refreshAccountMetadata: async () => undefined,
  };

  const service = new BrowserSyncService(connection as never, profiles as never);

  const first = service.syncAll();
  await new Promise((resolve) => setTimeout(resolve, 5));
  signalCheckedAt = "2026-10-26T12:00:05.000Z";
  const second = service.syncAll();

  const [ok1, ok2] = await Promise.all([first, second]);
  assert.equal(ok1, true);
  assert.equal(ok2, true);
  assert.equal(maxConcurrent, 1, "sync uploads must be serialized");
  assert.ok(uploadedCheckedAt.length >= 2, "dirty mark during flight must trigger a replay");
  assert.equal(uploadedCheckedAt.at(-1), "2026-10-26T12:00:05.000Z");
});

test("confirmLogin surfaces sanitized server failure without throwing", async () => {
  const connection = {
    onStateChange: () => () => undefined,
    isOnline: () => true,
    requestWithAuth: async () => {
      throw new SeoOpsHttpError({
        method: "POST",
        endpoint: "/api/v1/social-automation/client/session-confirm-login",
        status: 422,
        contentType: "application/json",
        category: "unexpected_response",
        serverErrorCode: "fresh_session_signal_required",
      });
    },
  };
  const service = new BrowserSyncService(connection as never, { list: () => [] } as never);
  const result = await service.confirmLogin(
    "b3f36077-9ca6-4d26-a94f-a7f45b331001",
    "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
    "2026-10-26T12:00:05.000Z",
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /fresh_session_signal_required/);
    assert.doesNotMatch(result.error, /cookie|password|token|Bearer/i);
  }
});

test("formatConfirmLoginFailure never echoes secrets", () => {
  const formatted = formatConfirmLoginFailure(
    new SeoOpsHttpError({
      method: "POST",
      endpoint: "/api/v1/social-automation/client/session-confirm-login",
      status: 422,
      contentType: "application/json",
      category: "unexpected_response",
      serverErrorCode: "fresh_session_signal_required",
      serverErrorMessage: "Bearer rpa_SECRET_VALUE leaked",
    }),
  );
  assert.match(formatted, /fresh_session_signal_required/);
  assert.doesNotMatch(formatted, /rpa_SECRET_VALUE/);
});

test("ACK failure path is independent of confirmLogin success shape", async () => {
  const connection = {
    onStateChange: () => () => undefined,
    isOnline: () => true,
    requestWithAuth: async (path: string) => {
      if (path.includes("session-confirm-login")) {
        return { ok: true, session_state: "candidate", dispatch_enabled: false };
      }
      if (path.includes("/ack")) {
        throw new Error("ack transport failed");
      }
      return { ok: true };
    },
  };
  const service = new BrowserSyncService(connection as never, { list: () => [] } as never);
  const confirmed = await service.confirmLogin(
    "b3f36077-9ca6-4d26-a94f-a7f45b331001",
    "820c2507-1ef8-46f2-a59e-7c6fe9fc9f83",
    "2026-10-26T12:00:05.000Z",
  );
  assert.deepEqual(confirmed, { ok: true, session_state: "candidate", dispatch_enabled: false });

  let ackFailed = false;
  try {
    await service.acknowledgeNotification("11111111-1111-1111-1111-111111111111");
  } catch {
    ackFailed = true;
  }
  assert.equal(ackFailed, true);
  // Session confirmLogin is independent of notification ACK transport failures.
  assert.equal(confirmed.ok, true);
});
