import path from "node:path";
import type { EmbeddedBrowser } from "../browser/embedded-browser.js";
import type { ProfileManager } from "../browser/profile-manager.js";
import type { BrowserSyncService } from "../browser/browser-sync-service.js";
import type { CampaignJobBrowserHost } from "./campaign-job-executor.js";
import { captureAndPersistFailureScreenshot } from "./failure-screenshot.js";
import { doesSiteKeyMatchSiteUrl, type CampaignJobClaim } from "./contracts.js";

/**
 * Adapt EmbeddedBrowser + ProfileManager for Campaign Job execution
 * on the Account's persist:rpa-client-{browserId} partition.
 */
export function createCampaignJobBrowserHost(params: {
  embeddedBrowser: EmbeddedBrowser;
  profileManager: ProfileManager;
  syncService: BrowserSyncService;
  artifactsDir?: string;
}): CampaignJobBrowserHost {
  const { embeddedBrowser, profileManager, syncService } = params;
  const artifactsDir =
    params.artifactsDir || path.join(process.cwd(), ".local", "artifacts", "campaign-jobs");

  return {
    prepareForExecution(browserId: string) {
      embeddedBrowser.prepareExecutionWindow(browserId);
    },
    async verifyExecutionViewport() {
      return embeddedBrowser.verifyExecutionViewport();
    },
    async captureFailureScreenshot(shotParams) {
      return captureAndPersistFailureScreenshot({
        webContents: embeddedBrowser.getWebContents(),
        jobId: shotParams.jobId,
        attemptId: shotParams.attemptId,
        errorCode: shotParams.code,
        artifactsDir,
        outcome: "failed",
        variantId: shotParams.variantId,
        languageLabel: shotParams.languageLabel,
        packageKey: shotParams.packageKey,
        releaseId: shotParams.releaseId,
        priority: shotParams.priority,
        screenshotRole: shotParams.screenshotRole,
        failedStep: shotParams.failedStep,
      });
    },
    async captureSuccessScreenshot(shotParams) {
      return captureAndPersistFailureScreenshot({
        webContents: embeddedBrowser.getWebContents(),
        jobId: shotParams.jobId,
        attemptId: shotParams.attemptId,
        errorCode: "OK",
        artifactsDir,
        outcome: "success",
        variantId: shotParams.variantId,
        languageLabel: shotParams.languageLabel,
        packageKey: shotParams.packageKey,
        releaseId: shotParams.releaseId,
        priority: shotParams.priority,
        screenshotRole: shotParams.screenshotRole ?? "final_success",
      });
    },
    async open(browserId: string) {
      // No Action Tag — job script is separate from Auth pipeline on open.
      await embeddedBrowser.open(browserId, undefined, null);
    },
    async navigate(url: string) {
      await embeddedBrowser.navigate(url);
    },
    getWebContents() {
      return embeddedBrowser.getWebContents();
    },
    getAuthState() {
      const auth = embeddedBrowser.getLastAuthResult();
      if (!auth) return null;
      return {
        code: auth.code,
        checkpointStatus: auth.checkpointStatus,
        message: auth.message,
      };
    },
    getBounds() {
      const b = embeddedBrowser.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    applyViewport(size) {
      embeddedBrowser.applyAuthViewport(size);
    },
    restoreViewport() {
      embeddedBrowser.restoreAuthViewport();
    },
    async lock(opts) {
      await embeddedBrowser.lockForAutomation({
        reason: opts.reason,
        message: opts.message,
        onStop: opts.onStop,
      });
    },
    async release(reason) {
      await embeddedBrowser.releaseAutomationLock(reason);
    },
    updateExecutionStatus(status) {
      embeddedBrowser.setExecutionStatus(status);
    },
    findProfileForJob(claim: CampaignJobClaim) {
      const byBrowser = profileManager.get(claim.browser_id);
      if (byBrowser) {
        const bound = byBrowser.accountBinding?.accountId || "";
        if (bound && bound !== claim.account_id) {
          return {
            ok: false as const,
            message: `browser_id ${claim.browser_id} bound to account ${bound}, job account_id=${claim.account_id}`,
          };
        }
        if (!bound) {
          return {
            ok: false as const,
            message: `browser_id ${claim.browser_id} không có Account binding.`,
          };
        }
        if (
          claim.site_key &&
          byBrowser.accountBinding?.siteUrl &&
          !doesSiteKeyMatchSiteUrl(claim.site_key, byBrowser.accountBinding.siteUrl)
        ) {
          return {
            ok: false as const,
            message: `Site mismatch: claim site_key=${claim.site_key} ≠ profile siteUrl=${byBrowser.accountBinding.siteUrl}`,
          };
        }
        return {
          ok: true as const,
          browserId: byBrowser.browserId,
          accountId: bound,
          partition: byBrowser.partition,
        };
      }

      const byAccount = profileManager.findByAccountId(claim.account_id);
      if (!byAccount) {
        return {
          ok: false as const,
          message: `Không tìm thấy Browser Profile cho account_id=${claim.account_id} / browser_id=${claim.browser_id}`,
        };
      }
      // Claim browser_id is authoritative when present on SEO-OPS; local mismatch → fail closed.
      if (claim.browser_id && byAccount.browserId !== claim.browser_id) {
        return {
          ok: false as const,
          message: `Account ${claim.account_id} local browser ${byAccount.browserId} ≠ claim browser_id ${claim.browser_id}`,
        };
      }
      if (
        claim.site_key &&
        byAccount.accountBinding?.siteUrl &&
        !doesSiteKeyMatchSiteUrl(claim.site_key, byAccount.accountBinding.siteUrl)
      ) {
        return {
          ok: false as const,
          message: `Site mismatch: claim site_key=${claim.site_key} ≠ profile siteUrl=${byAccount.accountBinding.siteUrl}`,
        };
      }
      return {
        ok: true as const,
        browserId: byAccount.browserId,
        accountId: claim.account_id,
        partition: byAccount.partition,
      };
    },
    async loadAccount(accountId: string) {
      const detail = await syncService.getAccount(accountId);
      const profile = profileManager.findByAccountId(accountId);
      const browserId = profile?.browserId || "";
      return {
        accountId,
        username: detail.username,
        email: detail.email,
        siteUrl: detail.siteUrl ?? profile?.accountBinding?.siteUrl ?? null,
        getPassword: async () => {
          if (!browserId) {
            throw new Error("Thiếu browserId để lấy password (ownership fence).");
          }
          return syncService.getAccountPassword(accountId, browserId);
        },
      };
    },
  };
}
