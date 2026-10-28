import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AccountBinding, AccountInfo, BrowserProfile, SessionSignal } from "../../shared/contracts.js";
// AccountInfo used by deprecated create() → createForAccount bridge.
import { logClientError, logClientEvent } from "../main-error-log.js";

function validateName(name: string): string {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
    throw new Error("Tên Browser Profile cần từ 1–80 ký tự.");
  }
  return name.trim();
}

export class ProfileManager {
  private profilesFile: string;
  private profiles: BrowserProfile[] = [];
  private activeBrowserId: string | null = null;
  private sessionResetCallback: ((browserId: string, partition: string) => Promise<void>) | null = null;

  constructor(userDataPath: string) {
    this.profilesFile = path.join(userDataPath, "browser-profiles.json");
  }

  setSessionResetCallback(fn: (browserId: string, partition: string) => Promise<void>): void {
    this.sessionResetCallback = fn;
  }

  async initialize(): Promise<void> {
    try {
      const data = await readFile(this.profilesFile, "utf-8");
      if (data.trim().length > 0) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          // Drop empty / unbound profiles — Browser requires Account ID.
          this.profiles = parsed
            .filter((p) => Boolean(p?.accountBinding?.accountId))
            .map((p) => ({
              ...p,
              status: "stopped" as const,
              // Display identity is Account Name; keep name only as optional legacy field.
              name: p.accountBinding?.accountName || p.name,
              accountBinding: p.accountBinding || { accountId: null, boundAt: null },
              sessionSignal: p.sessionSignal || { status: "unknown", checkedAt: null, method: null },
              executionConfirmation: p.executionConfirmation || {
                status: "not_run",
                firstRunAt: null,
                lastSuccessAt: null,
                lastRunId: null,
                screenshotRef: null,
              },
            }));
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logClientError("Failed to parse browser-profiles.json, resetting to empty", err);
      }
      this.profiles = [];
    }

    // Ensure file exists
    await this.save();
  }

  list(): BrowserProfile[] {
    return [...this.profiles];
  }

  get(browserId: string): BrowserProfile | undefined {
    return this.profiles.find((p) => p.browserId === browserId);
  }

  findByAccountId(accountId: string): BrowserProfile | undefined {
    if (!accountId) return undefined;
    return this.profiles.find((p) => p.accountBinding?.accountId === accountId);
  }

  getActiveId(): string | null {
    return this.activeBrowserId;
  }

  /**
   * Account-First Browser Creation.
   * Derives name and platform automatically from the SEO-OPS Account.
   * If an existing profile for this account exists on this device, reuses it to prevent duplicates.
   */
  async createForAccount(account: AccountInfo): Promise<{ profile: BrowserProfile; alreadyExists: boolean }> {
    if (!account || !account.accountId) {
      throw new Error("Không thể tạo Browser nếu chưa chọn Account.");
    }

    // If Account already has a Browser Profile on the same device: do not duplicate, reuse existing.
    const existing = this.findByAccountId(account.accountId);
    if (existing) {
      logClientEvent("Account already has browser profile on this device, reusing existing", {
        accountId: account.accountId,
        browserId: existing.browserId,
      });
      return { profile: existing, alreadyExists: true };
    }

    const rawName = account.displayName || account.username || "Account";
    const validName = validateName(rawName);
    const platform = (account.platform || "facebook").toLowerCase();
    const browserId = randomUUID();
    const now = new Date().toISOString();

    const profile: BrowserProfile = {
      browserId,
      name: validName,
      platform,
      partition: `persist:rpa-client-${browserId}`,
      status: "stopped",
      accountBinding: {
        accountId: account.accountId,
        boundAt: now,
        accountName: account.displayName || account.username || undefined,
        email: account.email,
        siteUrl: account.siteUrl ?? undefined,
      },
      sessionSignal: { status: "unknown", checkedAt: null, method: null },
      executionConfirmation: {
        status: "not_run",
        firstRunAt: null,
        lastSuccessAt: null,
        lastRunId: null,
        screenshotRef: null,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.profiles.push(profile);
    await this.save();
    logClientEvent("Created browser profile for account", {
      browserId,
      accountId: account.accountId,
      name: validName,
      platform,
    });
    return { profile, alreadyExists: false };
  }

  /**
   * @deprecated Use createForAccount. Browser Name is not a business identity.
   */
  async create(_name: string, platform: string = "facebook", accountBinding?: AccountBinding): Promise<BrowserProfile> {
    if (!accountBinding?.accountId) {
      throw new Error("Không thể tạo Browser nếu chưa chọn Account.");
    }
    const account: AccountInfo = {
      accountId: accountBinding.accountId,
      platform,
      displayName: accountBinding.accountName || _name || "Account",
      username: null,
      email: accountBinding.email ?? "legacy@local.test",
      siteUrl: accountBinding.siteUrl ?? null,
      identityLabel: null,
      verified: true,
    };
    const res = await this.createForAccount(account);
    return res.profile;
  }

  async bindAccount(
    browserId: string,
    accountId: string,
    accountName?: string,
    email?: string | null,
    siteUrl?: string | null,
    platform?: string
  ): Promise<BrowserProfile> {
    const profile = this.get(browserId);
    if (!profile) {
      throw new Error(`Browser profile ${browserId} không tồn tại.`);
    }

    const prevAccountId = profile.accountBinding?.accountId ?? null;
    if (prevAccountId !== accountId) {
      throw new Error("Account binding là bất biến. Hãy xóa Browser cũ và tạo Browser mới.");
    }
    const isAccountSwitch = false;

    if (platform && platform.trim()) {
      profile.platform = platform.toLowerCase().trim();
    }

    if (isAccountSwitch) {
      // Reset execution confirmation and session signal when switching account
      profile.executionConfirmation = {
        status: "not_run",
        firstRunAt: null,
        lastSuccessAt: null,
        lastRunId: null,
        screenshotRef: null,
      };
      profile.sessionSignal = {
        status: "unknown",
        checkedAt: null,
        method: null,
      };

      // Wipe partition cookies/storage to prevent Account B from reusing Account A's session
      if (this.sessionResetCallback) {
        try {
          await this.sessionResetCallback(browserId, profile.partition);
        } catch (err) {
          logClientError("Error during session reset on account switch", err);
        }
      }

      logClientEvent("Switched bound account, reset execution confirmation and session", {
        browserId,
        prevAccountId,
        newAccountId: accountId,
      });
    }

    profile.accountBinding = {
      accountId,
      boundAt: new Date().toISOString(),
      accountName: accountName ?? profile.accountBinding?.accountName,
      email: email ?? profile.accountBinding?.email ?? null,
      siteUrl: siteUrl ?? profile.accountBinding?.siteUrl ?? null,
    };
    profile.updatedAt = new Date().toISOString();

    await this.save();
    logClientEvent("Bound account to browser profile", { browserId, accountId, accountName, platform });
    return profile;
  }

  async unbindAccount(browserId: string): Promise<BrowserProfile> {
    const profile = this.get(browserId);
    if (!profile) {
      throw new Error(`Browser profile ${browserId} không tồn tại.`);
    }

    throw new Error("Không thể gỡ Account khỏi Browser. Hãy xóa Browser để bảo toàn session isolation.");
  }

  async updateSessionSignal(browserId: string, signal: SessionSignal): Promise<void> {
    const profile = this.get(browserId);
    if (!profile) return;

    profile.sessionSignal = signal;
    profile.updatedAt = new Date().toISOString();
    await this.save();
  }

  async refreshAccountMetadata(browserId: string, account: AccountInfo): Promise<void> {
    const profile = this.get(browserId);
    if (!profile || profile.accountBinding?.accountId !== account.accountId) return;
    profile.platform = account.platform.toLowerCase().trim();
    profile.accountBinding.accountName = account.displayName;
    profile.accountBinding.email = account.email;
    profile.accountBinding.siteUrl = account.siteUrl ?? null;
    profile.updatedAt = new Date().toISOString();
    await this.save();
  }

  async delete(browserId: string): Promise<boolean> {
    const index = this.profiles.findIndex((p) => p.browserId === browserId);
    if (index === -1) {
      return false;
    }

    if (this.activeBrowserId === browserId) {
      throw new Error("Không thể xóa Browser Profile đang chạy. Vui lòng dừng trình duyệt trước.");
    }

    const removed = this.profiles.splice(index, 1)[0];
    await this.save();
    logClientEvent("Deleted browser profile", { browserId: removed.browserId, name: removed.name });
    return true;
  }

  async setStatus(browserId: string, status: "stopped" | "running" | "error"): Promise<void> {
    const profile = this.get(browserId);
    if (!profile) return;

    if (status === "running") {
      // Single active browser constraint: Stop all other profiles
      for (const p of this.profiles) {
        if (p.browserId !== browserId && p.status === "running") {
          p.status = "stopped";
          p.updatedAt = new Date().toISOString();
        }
      }
      this.activeBrowserId = browserId;
    } else if (this.activeBrowserId === browserId) {
      this.activeBrowserId = null;
    }

    profile.status = status;
    profile.updatedAt = new Date().toISOString();
    await this.save();
  }

  async recordUrl(browserId: string, url: string): Promise<void> {
    const profile = this.get(browserId);
    if (!profile) return;
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol)) {
        profile.lastUrl = parsed.href;
        profile.updatedAt = new Date().toISOString();
        await this.save();
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.profilesFile), { recursive: true });
      await writeFile(this.profilesFile, JSON.stringify(this.profiles, null, 2), "utf-8");
    } catch (err) {
      logClientError("Failed to save browser profiles", err);
    }
  }
}
