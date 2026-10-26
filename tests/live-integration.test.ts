import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceManager } from "../src/main/device/device-manager.js";
import { ClientStore } from "../src/main/storage/store.js";
import { ClientCredentialStore } from "../src/main/storage/credential-store.js";
import { ClientConnection } from "../src/main/connection/client-connection.js";

const TEST_KEY = process.env.RPA_CLIENT_TEST_KEY || "";
const ENDPOINT = "https://seo-ops.test";

test("Live SEO-OPS E2E: Connect -> Register -> Heartbeat", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "client-live-test-"));
  try {
    const store = new ClientStore(tmpDir);
    await store.load();
    await store.set({ endpoint: ENDPOINT });

    const credentials = new ClientCredentialStore(tmpDir);
    const deviceManager = new DeviceManager(tmpDir);
    const devInfo = await deviceManager.initialize();

    const connection = new ClientConnection(store, credentials, deviceManager);

    // 1. Attempt connection with invalid key -> must throw 401
    await assert.rejects(
      async () => {
        await connection.connect("rpa_client_invalid_key_testing_12345");
      },
      /401|Authentication failed|không hợp lệ/i,
      "Invalid key must fail authentication"
    );

    // If live API key is not supplied via environment, skip live connection steps safely


    if (!TEST_KEY) {


      t.skip("Skipping live connection steps: RPA_CLIENT_TEST_KEY environment variable not set");


      return;


    }



    // 2. Connect with valid live key -> must succeed


    const connectedState = await connection.connect(TEST_KEY);
    assert.strictEqual(connectedState.status, "connected");
    assert.strictEqual(connectedState.online, true);
    assert.ok(connectedState.agentUuid, "Must receive agentUuid from SEO-OPS");
    assert.strictEqual(connectedState.device?.deviceId, devInfo.deviceId);
    assert.strictEqual(connectedState.installation?.installationId, "ins_Np0k703LfZX1EHjM");

    // 3. Heartbeat -> must succeed
    const hbResult = await connection.triggerHeartbeatNow();
    assert.strictEqual(hbResult, true, "Heartbeat must return true");

    const stateAfterHb = connection.getState();
    assert.strictEqual(stateAfterHb.online, true);
    assert.ok(stateAfterHb.lastHeartbeatAt, "Must update lastHeartbeatAt");

    // 4. Disconnect -> status must be disconnected and credentials cleared
    const discState = await connection.disconnect();
    assert.strictEqual(discState.status, "disconnected");
    assert.strictEqual(discState.online, false);
    assert.strictEqual(credentials.hasKey(), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
