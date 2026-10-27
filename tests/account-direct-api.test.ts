import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSyncService } from "../src/main/browser/browser-sync-service.js";

test("account password is fetched only by the explicit copy request", async () => {
  const requests: string[] = [];
  const connection = {
    onStateChange: () => () => undefined,
    requestWithAuth: async (path: string) => {
      requests.push(path);
      if (path.endsWith("/password")) return { ok: true, password: "secret-value" };
      return { ok: true, account: { account_id: "acc-1", platform: "facebook", display_name: "A", email: "a@example.com", password_status: "available" } };
    },
  };
  const profiles = { list: () => [] };
  const service = new BrowserSyncService(connection as never, profiles as never);

  const account = await service.getAccount("acc-1");
  assert.equal(account.passwordStatus, "available");
  assert.equal(requests.some((path) => path.endsWith("/password")), false);

  assert.equal(await service.getAccountPassword("acc-1"), "secret-value");
  assert.equal(requests.at(-1), "/api/v1/social-automation/client/accounts/acc-1/password");
});
