import { SeoOpsHttpError } from "../../shared/seo-ops-http.js";
import type { ClientConnection } from "../connection/client-connection.js";
import {
  parseCampaignJobClaim,
  type CampaignJobAckRequest,
  type CampaignJobApiResult,
  type CampaignJobArtifactUploadRequest,
  type CampaignJobArtifactUploadResponse,
  type CampaignJobClaim,
  type CampaignJobProgressRequest,
  type CampaignJobResultRequest,
} from "./contracts.js";

const BASE = "/api/v1/social-automation/client/jobs";

/**
 * Typed Client Job APIs (OpenAPI clientJobsClaim|Ack|Progress|Result).
 * Auth: Bearer Client API Key only.
 */
export class CampaignJobApi {
  constructor(
    private readonly connection: Pick<ClientConnection, "requestWithAuth" | "isOnline">
  ) {}

  async claim(params: {
    agentUuid: string;
    browserIds: string[];
  }): Promise<CampaignJobApiResult<CampaignJobClaim | null>> {
    if (!this.connection.isOnline()) {
      return { ok: false, status: 0, errors: ["client_offline"], message: "Client offline." };
    }
    try {
      const res = await this.connection.requestWithAuth(`${BASE}/claim`, "POST", {
        agent_uuid: params.agentUuid,
        browser_ids: params.browserIds,
      });
      if (res.ok !== true) {
        return {
          ok: false,
          status: 422,
          errors: asErrors(res),
          message: "Claim rejected.",
        };
      }
      if (res.data == null) {
        return { ok: true, data: null };
      }
      const claim = parseCampaignJobClaim(res.data);
      if (!claim) {
        return {
          ok: false,
          status: 422,
          errors: ["invalid_claim_payload"],
          message: "Claim response missing required job/attempt/lease/account fields.",
        };
      }
      return { ok: true, data: claim };
    } catch (err) {
      return mapHttpError(err, "claim_failed");
    }
  }

  async ack(jobId: string, body: CampaignJobAckRequest): Promise<CampaignJobApiResult<unknown>> {
    return this.postFence(`${BASE}/${encodeURIComponent(jobId)}/ack`, body, "ack_failed");
  }

  async progress(
    jobId: string,
    body: CampaignJobProgressRequest
  ): Promise<CampaignJobApiResult<unknown>> {
    return this.postFence(`${BASE}/${encodeURIComponent(jobId)}/progress`, body, "progress_failed");
  }

  async result(
    jobId: string,
    body: CampaignJobResultRequest
  ): Promise<CampaignJobApiResult<unknown>> {
    return this.postFence(`${BASE}/${encodeURIComponent(jobId)}/result`, body, "result_failed");
  }

  async uploadArtifact(
    jobId: string,
    body: CampaignJobArtifactUploadRequest
  ): Promise<CampaignJobApiResult<CampaignJobArtifactUploadResponse>> {
    if (!this.connection.isOnline()) {
      return { ok: false, status: 0, errors: ["client_offline"], message: "Client offline." };
    }
    try {
      const res = await this.connection.requestWithAuth(
        `${BASE}/${encodeURIComponent(jobId)}/artifacts`,
        "POST",
        body as unknown as Record<string, unknown>
      );
      const dataObj =
        res.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? (res.data as Record<string, unknown>)
          : null;
      const rawArtifact =
        (res.artifact && typeof res.artifact === "object" && !Array.isArray(res.artifact)
          ? (res.artifact as Record<string, unknown>)
          : null) ??
        (dataObj?.artifact && typeof dataObj.artifact === "object" && !Array.isArray(dataObj.artifact)
          ? (dataObj.artifact as Record<string, unknown>)
          : null);

      const okFlag = res.ok === true || Boolean(rawArtifact);
      if (!okFlag) {
        return {
          ok: false,
          status: 422,
          errors: asErrors(res),
          message:
            typeof res.message === "string" && res.message.trim()
              ? res.message
              : "artifact_upload_failed",
        };
      }

      const artifactUuid =
        typeof rawArtifact?.artifact_uuid === "string" ? rawArtifact.artifact_uuid.trim() : "";
      if (!artifactUuid) {
        return {
          ok: false,
          status: 502,
          errors: ["invalid_artifact_response"],
          message: "Backend artifact response missing artifact.artifact_uuid.",
        };
      }

      const checksumSha256 =
        typeof rawArtifact?.checksum_sha256 === "string" && rawArtifact.checksum_sha256.trim()
          ? rawArtifact.checksum_sha256.trim().toLowerCase()
          : null;

      return {
        ok: true,
        data: {
          artifact_uuid: artifactUuid,
          checksum_sha256: checksumSha256,
        },
        idempotent: Boolean(res.idempotent),
      };
    } catch (err) {
      return mapHttpError(err, "artifact_upload_failed");
    }
  }

  private async postFence(
    path: string,
    body: Record<string, unknown>,
    fallback: string
  ): Promise<CampaignJobApiResult<unknown>> {
    if (!this.connection.isOnline()) {
      return { ok: false, status: 0, errors: ["client_offline"], message: "Client offline." };
    }
    try {
      const res = await this.connection.requestWithAuth(path, "POST", body);
      if (res.ok !== true) {
        return {
          ok: false,
          status: 422,
          errors: asErrors(res),
          message: typeof res.message === "string" && res.message.trim() ? res.message : fallback,
        };
      }
      return {
        ok: true,
        data: res.data ?? null,
        idempotent: Boolean(res.idempotent),
      };
    } catch (err) {
      return mapHttpError(err, fallback);
    }
  }
}

function asErrors(res: Record<string, unknown>): string[] {
  if (Array.isArray(res.errors)) {
    return res.errors.map((e) => String(e));
  }
  if (typeof res.error === "string") return [res.error];
  return ["request_failed"];
}

function mapHttpError(err: unknown, fallback: string): CampaignJobApiResult<never> {
  if (err instanceof SeoOpsHttpError) {
    const code = err.diagnostic.serverErrorCode;
    return {
      ok: false,
      status: err.diagnostic.status,
      errors: code ? [code] : [fallback],
      message: err.diagnostic.serverErrorMessage || err.message,
    };
  }
  return {
    ok: false,
    status: 0,
    errors: [fallback],
    message: err instanceof Error ? err.message : String(err),
  };
}
