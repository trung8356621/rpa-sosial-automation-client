/**
 * Client Campaign Job contracts (CP19A + Client Action Script APIs).
 *
 * Live deploy (seo-ops.duckdns.org) exposes:
 *   POST /api/v1/social-automation/client/scripts/pull
 *   POST /api/v1/social-automation/client/scripts/asset
 * GitHub openapi.yaml @5554eda still lags — do not treat that commit as source of truth.
 */

export type CampaignRunMode = "test" | "live";
export type CampaignExecutionMode = "one_account_one_job" | "one_account_many_jobs";
export type CampaignJobResultStatus = "succeeded" | "failed" | "cancelled" | "unknown";

/**
 * Claim payload. Exact script pin fields are required before pull/execute:
 * package_key (=script_id), version, release_id, content_digest, execution_digest.
 *
 * Digests are distinct:
 * - content_digest: package/content identity
 * - execution_digest: execution payload identity (never swap with content_digest)
 */
export type CampaignJobClaim = {
  job_id: string;
  attempt_id: string;
  campaign_id: string;
  content_id: string;
  browser_id: string;
  account_id: string;
  /** Package key (Addon: campaign.script_id → job.package_key). */
  script_id: string;
  script_version: string;
  run_mode: CampaignRunMode;
  execution_mode: CampaignExecutionMode;
  input: Record<string, unknown>;
  lease_token: string;
  lease_expires_at: string;
  release_id?: number;
  content_digest?: string;
  execution_digest?: string;
};

export type CampaignJobAckRequest = {
  attempt_id: string;
  lease_token: string;
};

export type CampaignJobProgressRequest = {
  attempt_id: string;
  lease_token: string;
  message?: string;
  percent?: number;
  step?: string;
};

export type CampaignJobResultRequest = {
  attempt_id: string;
  lease_token: string;
  status: CampaignJobResultStatus;
  output?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  artifacts?: Array<Record<string, unknown>>;
};

export type CampaignJobApiResult<T> =
  | { ok: true; data: T; idempotent?: boolean }
  | { ok: false; status: number; errors: string[]; message: string };

export type CampaignScriptContractGap = {
  code: "CONTRACT_GAP_SCRIPT_PULL" | "CONTRACT_GAP_SCRIPT_ASSET" | "CONTRACT_GAP_CLAIM_PIN";
  missing: string[];
  message: string;
};

export type CampaignScriptPin = {
  package_key: string;
  version: string;
  release_id: number;
  content_digest: string;
  execution_digest: string;
};

export const REQUIRED_CAMPAIGN_SCRIPT_APIS = [
  "POST /api/v1/social-automation/client/scripts/pull",
  "POST /api/v1/social-automation/client/scripts/asset",
] as const;

/** Live Action Script APIs are deployed (route returns 401 without key, not 404). */
export const CAMPAIGN_SCRIPT_APIS_AVAILABLE = true;

export function parseCampaignJobClaim(raw: unknown): CampaignJobClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const job_id = str(r.job_id);
  const attempt_id = str(r.attempt_id);
  const browser_id = str(r.browser_id);
  const account_id = str(r.account_id);
  const script_id = str(r.script_id) || str(r.package_key);
  const script_version = str(r.script_version) || str(r.version) || str(r.package_version);
  const lease_token = str(r.lease_token);
  if (!job_id || !attempt_id || !browser_id || !account_id || !script_id || !script_version || !lease_token) {
    return null;
  }
  const run_mode = r.run_mode === "test" ? "test" : "live";
  const execution_mode =
    r.execution_mode === "one_account_one_job" ? "one_account_one_job" : "one_account_many_jobs";
  const input =
    r.input && typeof r.input === "object" && !Array.isArray(r.input)
      ? (r.input as Record<string, unknown>)
      : {};
  const releaseId = Number(r.release_id);
  return {
    job_id,
    attempt_id,
    campaign_id: str(r.campaign_id) || "",
    content_id: str(r.content_id) || "",
    browser_id,
    account_id,
    script_id,
    script_version,
    run_mode,
    execution_mode,
    input,
    lease_token,
    lease_expires_at: str(r.lease_expires_at) || "",
    release_id: Number.isFinite(releaseId) && releaseId > 0 ? releaseId : undefined,
    content_digest: digestHex(r.content_digest) || undefined,
    execution_digest: digestHex(r.execution_digest) || undefined,
  };
}

/** Exact pin required before Action Script pull. */
export function resolveClaimScriptPin(claim: CampaignJobClaim): CampaignScriptPin | null {
  const content_digest = digestHex(claim.content_digest);
  const execution_digest = digestHex(claim.execution_digest);
  const release_id = claim.release_id;
  if (!content_digest || !execution_digest) return null;
  if (!release_id || release_id < 1) return null;
  if (!claim.script_id || !claim.script_version) return null;
  // Never treat digests as interchangeable.
  if (content_digest === execution_digest) {
    // Same value is allowed only if Addon truly emits equal digests; still keep fields distinct in checks.
  }
  return {
    package_key: claim.script_id,
    version: claim.script_version,
    release_id,
    content_digest,
    execution_digest,
  };
}

export function campaignScriptContractGap(
  code: CampaignScriptContractGap["code"] = "CONTRACT_GAP_SCRIPT_PULL",
  missing: string[] = [...REQUIRED_CAMPAIGN_SCRIPT_APIS]
): CampaignScriptContractGap {
  return {
    code,
    missing,
    message:
      "CONTRACT GAP: Client Campaign Job needs Action Script pull/asset + exact claim pin " +
      "(release_id, content_digest, execution_digest). Do not use /client/auth/* for Action Scripts.",
  };
}

export function claimPinGap(): CampaignScriptContractGap {
  return campaignScriptContractGap("CONTRACT_GAP_CLAIM_PIN", [
    "CampaignJobClaim.release_id",
    "CampaignJobClaim.content_digest",
    "CampaignJobClaim.execution_digest",
  ]);
}

/** @deprecated Use resolveClaimScriptPin — content_digest only is insufficient. */
export function resolveClaimDigest(claim: CampaignJobClaim): string | null {
  return digestHex(claim.content_digest);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function digestHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(d) ? d : null;
}
