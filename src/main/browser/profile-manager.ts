import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserProfile, SessionSignal } from "../../shared/contracts.js";
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

  constructor(userDataPath: string) {
    this.profilesFile = path.join(userDataPath, "browser-profiles.json");
  }

  async initialize(): Promise<void> {
    try {
      const data = await readFile(this.profilesFile, "utf-8");
      if (data.trim().length > 0) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.profiles = parsed.map((p) => ({
            ...p,
            // When starting up after restart or crash, all browsers must start as 'stopped'
            status: "stopped" as const,
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

  getActiveId(): string | null {
    return this.activeBrowserId;
  }

  async create(name: string, platform: string = "facebook"): Promise<BrowserProfile> {
    const validName = validateName(name);
    const browserId = randomUUID();
    const now = new Date().toISOString();

    const profile: BrowserProfile = {
      browserId,
      name: validName,
      platform: platform.toLowerCase(),
      // Partition is strictly tied to browserId and NEVER changes on rename
      partition: `persist:rpa-client-${browserId}`,
      status: "stopped",
      accountBinding: { accountId: null, boundAt: null },
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
    logClientEvent("Created browser profile", { browserId, name: validName, platform });
    return profile;
  }

  async rename(browserId: string, name: string): Promise<BrowserProfile> {
    const validName = validateName(name);
    const profile = this.get(browserId);
    if (!profile) {
      throw new Error(`Browser profile ${browserId} không tồn tại.`);
    }

    profile.name = validName;
    profile.updatedAt = new Date().toISOString();
    await this.save();
    logClientEvent("Renamed browser profile", { browserId, newName: validName });
    return profile;
  }

  async bindAccount(browserId: string, accountId: string, accountName?: string): Promise<BrowserProfile> {
    const profile = this.get(browserId);
    if (!profile) {
      throw new Error(`Browser profile ${browserId} không tồn tại.`);
    }

    const prevAccountId = profile.accountBinding?.accountId ?? null;
    const isAccountSwitch = prevAccountId !== accountId;

    if (isAccountSwitch) {
      // E5.3: Reset execution confirmation when switching account
      profile.executionConfirmation = {
        status: "not_run",
        firstRunAt: null,
        lastSuccessAt: null,
        lastRunId: null,
        screenshotRef: null,
      };
      logClientEvent("Switched bound account, reset execution confirmation", { browserId, prevAccountId, newAccountId: accountId });
    }

    profile.accountBinding = {
      accountId,
      boundAt: new Date().toISOString(),
      accountName,
    };
    profile.updatedAt = new Date().toISOString();

    await this.save();
    logClientEvent("Bound account to browser profile", { browserId, accountId, accountName });
    return profile;
  }

  async unbindAccount(browserId: string): Promise<BrowserProfile> {
    const profile = this.get(browserId);
    if (!profile) {
      throw new Error(`Browser profile ${browserId} không tồn tại.`);
    }

    profile.accountBinding = {
      accountId: null,
      boundAt: null,
    };
    profile.executionConfirmation = {
      status: "not_run",
      firstRunAt: null,
      lastSuccessAt: null,
      lastRunId: null,
      screenshotRef: null,
    };
    profile.updatedAt = new Date().toISOString();

    await this.save();
    logClientEvent("Unbound account from browser profile", { browserId });
    return profile;
  }

  async updateSessionSignal(browserId: string, signal: SessionSignal): Promise<void> {
    const profile = this.get(browserId);
    if (!profile) return;

    profile.sessionSignal = signal;
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
