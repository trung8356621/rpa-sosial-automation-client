import type { ClientConnection } from "../connection/client-connection.js";
import type { ProfileManager } from "../browser/profile-manager.js";
import { logClientError, logClientEvent } from "../main-error-log.js";
import { CampaignJobApi } from "./campaign-job-api.js";
import {
  CAMPAIGN_SCRIPT_APIS_AVAILABLE,
  campaignScriptContractGap,
  type CampaignJobClaim,
} from "./contracts.js";
import { CampaignJobExecutor } from "./campaign-job-executor.js";
import { CampaignScriptLoader } from "./campaign-script-loader.js";

const POLL_INTERVAL_MS = 15_000;

/**
 * Online-gated Campaign Job poller (claim → executor).
 *
 * Claims only when:
 * 1) script loader readiness passes (Action Script pull/asset wired)
 * 2) runtime enabled (main sets via RPA_CAMPAIGN_CLAIM / setEnabled)
 */
export class CampaignJobWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private wasOnline = false;
  private gapLogged = false;
  private enabled = false;

  constructor(
    private readonly connection: ClientConnection,
    private readonly profileManager: ProfileManager,
    private readonly api: CampaignJobApi,
    private readonly executor: CampaignJobExecutor,
    private readonly scriptLoader: CampaignScriptLoader = new CampaignScriptLoader()
  ) {
    this.connection.onStateChange((state) => {
      const online = state.status === "connected" && state.online;
      if (online && !this.wasOnline) {
        void this.tick("connect");
        this.startPeriodic();
      } else if (!online) {
        this.stopPeriodic();
        this.executor.cancelActive("offline");
      }
      this.wasOnline = online;
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  startPeriodic(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick("interval");
    }, POLL_INTERVAL_MS);
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    this.stopPeriodic();
    this.executor.cancelActive("destroy");
  }

  readiness(): {
    jobsApi: true;
    scriptPullReady: boolean;
    gap: ReturnType<typeof campaignScriptContractGap> | null;
  } {
    const gap = this.scriptLoader.readiness();
    return {
      jobsApi: true,
      scriptPullReady: gap == null && CAMPAIGN_SCRIPT_APIS_AVAILABLE,
      gap,
    };
  }

  async tick(reason: string): Promise<CampaignJobClaim | null> {
    if (!this.enabled || !this.connection.isOnline() || this.inFlight) {
      return null;
    }

    const ready = this.readiness();
    if (!ready.scriptPullReady) {
      if (!this.gapLogged) {
        this.gapLogged = true;
        logClientEvent("CAMPAIGN_JOB_WORKER_BLOCKED_CONTRACT_GAP", {
          reason,
          missing: ready.gap?.missing,
          message: ready.gap?.message,
        });
      }
      return null;
    }

    const agentUuid = this.connection.getState().agentUuid;
    if (!agentUuid) {
      return null;
    }
    const browserIds = this.profileManager
      .list()
      .filter((p) => p.accountBinding?.accountId)
      .map((p) => p.browserId);
    if (browserIds.length === 0) {
      return null;
    }

    this.inFlight = true;
    try {
      await this.executor.flushPendingResults?.();
      const claimed = await this.api.claim({ agentUuid, browserIds });
      if (!claimed.ok) {
        logClientError("CAMPAIGN_JOB_CLAIM_FAILED", {
          reason,
          errors: claimed.errors,
          message: claimed.message,
        });
        return null;
      }
      if (!claimed.data) {
        return null;
      }

      logClientEvent("CAMPAIGN_JOB_CLAIMED", {
        reason,
        jobId: claimed.data.job_id,
        attemptId: claimed.data.attempt_id,
        accountId: claimed.data.account_id,
        browserId: claimed.data.browser_id,
        scriptId: claimed.data.script_id,
        scriptVersion: claimed.data.script_version,
        runMode: claimed.data.run_mode,
      });

      const out = await this.executor.execute(claimed.data);
      logClientEvent("CAMPAIGN_JOB_EXECUTE_DONE", {
        jobId: claimed.data.job_id,
        attemptId: claimed.data.attempt_id,
        status: out.status,
        code: out.code,
        reported: out.reported,
        draftVerified: out.draftVerified ?? false,
        idempotentSkip: out.idempotentSkip ?? false,
      });
      return claimed.data;
    } catch (err) {
      logClientError("CAMPAIGN_JOB_WORKER_TICK_FAILED", err);
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
