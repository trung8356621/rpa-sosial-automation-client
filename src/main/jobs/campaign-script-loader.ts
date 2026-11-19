import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import type { AuthReleasePulled } from "../auth/auth-script-types.js";
import { parsePulledRelease } from "../auth/auth-script-types.js";
import type { AuthAssetDownloader } from "../orc/asset-store.js";
import {
  CAMPAIGN_SCRIPT_APIS_AVAILABLE,
  campaignScriptContractGap,
  claimPinGap,
  digestHex,
  resolveClaimScriptPin,
  type CampaignJobClaim,
  type CampaignScriptContractGap,
  type CampaignScriptPin,
} from "./contracts.js";

const PULL_PATH = "/api/v1/social-automation/client/scripts/pull";
const ASSET_PATH = "/api/v1/social-automation/client/scripts/asset";

export type CampaignReleasePulled = AuthReleasePulled & {
  execution_digest: string;
};

export type CampaignScriptPullOutcome =
  | {
      kind: "ok";
      release: CampaignReleasePulled;
      pinned: CampaignScriptPin;
    }
  | { kind: "contract_gap"; gap: CampaignScriptContractGap }
  | { kind: "error"; code: string; message: string };

type ConnectionLike = Pick<
  ClientConnection,
  "requestWithAuth" | "getConnectionToken" | "isOnline"
>;

/**
 * Pull exact pinned Action Script release + download ROI assets.
 * Uses /client/scripts/* only — never /client/auth/*.
 */
export class CampaignScriptLoader {
  constructor(
    private readonly connection?: ConnectionLike,
    /** Test double — bypasses HTTP when provided. */
    private readonly pullImpl?: (claim: CampaignJobClaim) => Promise<CampaignScriptPullOutcome>
  ) {}

  readiness(): CampaignScriptContractGap | null {
    if (!CAMPAIGN_SCRIPT_APIS_AVAILABLE) {
      return campaignScriptContractGap();
    }
    if (!this.connection && !this.pullImpl) {
      return campaignScriptContractGap("CONTRACT_GAP_SCRIPT_PULL", [
        "CampaignScriptLoader.connection",
      ]);
    }
    return null;
  }

  async pullPinned(claim: CampaignJobClaim): Promise<CampaignScriptPullOutcome> {
    const gap = this.readiness();
    if (gap) return { kind: "contract_gap", gap };

    const pin = resolveClaimScriptPin(claim);
    if (!pin) {
      return { kind: "contract_gap", gap: claimPinGap() };
    }

    if (this.pullImpl) {
      const out = await this.pullImpl(claim);
      if (out.kind !== "ok") return out;
      return this.validatePinned(pin, out.release);
    }

    if (!this.connection) {
      return { kind: "contract_gap", gap: campaignScriptContractGap() };
    }
    if (!this.connection.isOnline()) {
      return { kind: "error", code: "CLIENT_OFFLINE", message: "Client offline." };
    }
    const connection_token = this.connection.getConnectionToken();
    if (!connection_token) {
      return {
        kind: "error",
        code: "CLIENT_LEASE_INVALID",
        message: "Thiếu connection_token (connection lease).",
      };
    }

    try {
      const res = await this.connection.requestWithAuth(PULL_PATH, "POST", {
        connection_token,
        job_id: claim.job_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
        account_id: claim.account_id,
        package_key: pin.package_key,
        version: pin.version,
        release_id: pin.release_id,
      });

      if (res.ok !== true) {
        return {
          kind: "error",
          code: "SCRIPT_PULL_REJECTED",
          message: "scripts/pull rejected (ok!=true).",
        };
      }

      const release = parseCampaignActionRelease(res.release);
      if (!release) {
        return {
          kind: "error",
          code: "SCRIPT_PULL_INVALID",
          message: "scripts/pull response thiếu release/manifest/digests.",
        };
      }

      return this.validatePinned(pin, release);
    } catch (err) {
      return mapPullError(err);
    }
  }

  /**
   * AuthAssetDownloader bound to a claimed job fence.
   * Downloads via /client/scripts/asset and relies on OrcAssetStore for SHA-256 verify.
   */
  createAssetDownloader(claim: CampaignJobClaim): AuthAssetDownloader {
    return async (params) => {
      if (!this.connection) {
        return { status: 503, body: { error: "script_loader_unwired" } };
      }
      const connection_token = this.connection.getConnectionToken();
      if (!connection_token) {
        return { status: 409, body: { error: "connection_token_required" } };
      }
      try {
        const body = await this.connection.requestWithAuth(ASSET_PATH, "POST", {
          connection_token,
          job_id: claim.job_id,
          attempt_id: claim.attempt_id,
          lease_token: claim.lease_token,
          account_id: claim.account_id || params.accountId,
          package_key: params.packageKey,
          version: params.version,
          release_id: params.releaseId,
          asset_path: params.assetPath,
          expected_sha256: params.expectedSha256,
        });
        return { status: 200, body };
      } catch (err) {
        if (err instanceof SeoOpsHttpError) {
          return {
            status: err.diagnostic.status,
            body: { error: err.diagnostic.serverErrorCode || "asset_download_failed" },
          };
        }
        return { status: 0, body: { error: "asset_download_failed" } };
      }
    };
  }

  private validatePinned(
    pin: CampaignScriptPin,
    release: CampaignReleasePulled
  ): CampaignScriptPullOutcome {
    if (release.package_key !== pin.package_key) {
      return {
        kind: "error",
        code: "SCRIPT_PIN_MISMATCH",
        message: `package_key mismatch: expected ${pin.package_key}`,
      };
    }
    if (release.version !== pin.version) {
      return {
        kind: "error",
        code: "SCRIPT_PIN_MISMATCH",
        message: `version mismatch: expected ${pin.version}`,
      };
    }
    if (release.release_id !== pin.release_id) {
      return {
        kind: "error",
        code: "SCRIPT_PIN_MISMATCH",
        message: `release_id mismatch: expected ${pin.release_id}`,
      };
    }
    // Distinct digest checks — never cross-compare content ↔ execution.
    if (release.content_digest !== pin.content_digest) {
      return {
        kind: "error",
        code: "CONTENT_DIGEST_MISMATCH",
        message: "content_digest mismatch between claim pin and pull",
      };
    }
    if (release.execution_digest !== pin.execution_digest) {
      return {
        kind: "error",
        code: "EXECUTION_DIGEST_MISMATCH",
        message: "execution_digest mismatch between claim pin and pull",
      };
    }
    if (release.status !== "published") {
      return {
        kind: "error",
        code: "SCRIPT_NOT_PUBLISHED",
        message: `release status=${release.status}`,
      };
    }
    if (!release.assets_complete || !release.ready_to_execute) {
      return {
        kind: "error",
        code: "SCRIPT_ASSETS_INCOMPLETE",
        message: "pulled release assets_complete/ready_to_execute=false",
      };
    }
    if (release.is_authentication === true) {
      // Action Script path must not silently accept Auth packages for create_post.
      // Allow only when claim intentionally pinned an auth package (rare); still OK to run ORC.
    }
    return { kind: "ok", release, pinned: pin };
  }
}

export function parseCampaignActionRelease(raw: unknown): CampaignReleasePulled | null {
  const base = parsePulledRelease(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  const execution_digest = digestHex(r.execution_digest);
  if (!execution_digest) return null;
  return { ...base, execution_digest };
}

function mapPullError(err: unknown): CampaignScriptPullOutcome {
  if (err instanceof SeoOpsHttpError) {
    const code = err.diagnostic.serverErrorCode || "SCRIPT_PULL_FAILED";
    if (err.diagnostic.status === 404) {
      return {
        kind: "contract_gap",
        gap: campaignScriptContractGap("CONTRACT_GAP_SCRIPT_PULL", [PULL_PATH]),
      };
    }
    return {
      kind: "error",
      code,
      message: err.diagnostic.serverErrorMessage || err.message,
    };
  }
  return {
    kind: "error",
    code: "SCRIPT_PULL_FAILED",
    message: err instanceof Error ? err.message : String(err),
  };
}
