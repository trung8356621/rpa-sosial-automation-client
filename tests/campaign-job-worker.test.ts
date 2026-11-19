import assert from "node:assert/strict";
import test from "node:test";
import { CampaignJobWorker } from "../src/main/jobs/campaign-job-worker.js";
import { CampaignScriptLoader } from "../src/main/jobs/campaign-script-loader.js";
import {
  CAMPAIGN_SCRIPT_APIS_AVAILABLE,
  resolveClaimScriptPin,
  type CampaignJobClaim,
} from "../src/main/jobs/contracts.js";

const CONTENT = "a".repeat(64);
const EXEC = "b".repeat(64);

function sampleClaim(): CampaignJobClaim {
  return {
    job_id: "11111111-1111-1111-1111-111111111111",
    attempt_id: "22222222-2222-2222-2222-222222222222",
    campaign_id: "camp-1",
    content_id: "content-1",
    browser_id: "b1",
    account_id: "a1",
    script_id: "00c6ca04-0000-0000-0000-000000000001",
    script_version: "1",
    run_mode: "test",
    execution_mode: "one_account_one_job",
    input: { title: "T" },
    lease_token: "lease",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    release_id: 1,
    content_digest: CONTENT,
    execution_digest: EXEC,
  };
}

test("worker gate OPEN when Action Script loader is wired; runtime claim stays opt-in", async () => {
  assert.equal(CAMPAIGN_SCRIPT_APIS_AVAILABLE, true);
  let claimCalls = 0;
  const connection = {
    isOnline: () => true,
    getState: () => ({
      status: "connected",
      online: true,
      agentUuid: "agent-1",
      endpoint: "https://example.test",
      hasKey: true,
    }),
    getConnectionToken: () => "tok",
    requestWithAuth: async () => ({ ok: true, data: null }),
    onStateChange: () => () => undefined,
  };
  const profileManager = {
    list: () => [{ browserId: "b1", accountBinding: { accountId: "a1" } }],
  };
  const api = {
    claim: async () => {
      claimCalls += 1;
      return { ok: true, data: null };
    },
  };
  const executor = {
    cancelActive: () => undefined,
    execute: async () => {
      throw new Error("should not execute");
    },
  };
  const loader = new CampaignScriptLoader(connection as never);
  const worker = new CampaignJobWorker(
    connection as never,
    profileManager as never,
    api as never,
    executor as never,
    loader
  );

  const ready = worker.readiness();
  assert.equal(ready.jobsApi, true);
  assert.equal(ready.scriptPullReady, true);
  assert.equal(ready.gap, null);

  // Default enabled=false — no production claim until setEnabled(true) / RPA_CAMPAIGN_CLAIM=1
  const claimedOff = await worker.tick("test");
  assert.equal(claimedOff, null);
  assert.equal(claimCalls, 0);

  worker.setEnabled(true);
  const claimedOn = await worker.tick("enabled");
  assert.equal(claimedOn, null);
  assert.equal(claimCalls, 1, "empty claim allowed when runtime enabled");
  worker.destroy();
});

test("claim pin helper rejects incomplete production-shaped claims", () => {
  const full = sampleClaim();
  assert.ok(resolveClaimScriptPin(full));
  assert.equal(resolveClaimScriptPin({ ...full, content_digest: undefined }), null);
  assert.equal(resolveClaimScriptPin({ ...full, execution_digest: undefined }), null);
});
