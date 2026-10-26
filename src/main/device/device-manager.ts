import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DeviceInfo } from "../../shared/contracts.js";

const CLIENT_VERSION = "0.1.0";

export class DeviceManager {
  private filePath: string;
  private deviceId: string | null = null;
  private displayName: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "device.json");
    this.displayName = os.hostname() || "Windows Desktop Client";
  }

  async initialize(): Promise<DeviceInfo> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      if (typeof parsed.deviceId === "string" && parsed.deviceId.length >= 10) {
        this.deviceId = parsed.deviceId;
      }
      if (typeof parsed.displayName === "string" && parsed.displayName.trim()) {
        this.displayName = parsed.displayName.trim();
      }
    } catch {
      // Not initialized yet
    }

    if (!this.deviceId) {
      this.deviceId = `dev_${randomUUID()}`;
      await this.persist();
    }

    return this.getDeviceInfo();
  }

  getDeviceInfo(): DeviceInfo {
    if (!this.deviceId) {
      throw new Error("DeviceManager must be initialized before getDeviceInfo");
    }
    return {
      deviceId: this.deviceId,
      displayName: this.displayName,
      platform: process.platform === "win32" ? "windows" : process.platform,
      osVersion: `${os.type()} ${os.release()} (${os.arch()})`,
      clientVersion: CLIENT_VERSION,
    };
  }

  async setDisplayName(name: string): Promise<DeviceInfo> {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed.length <= 100) {
      this.displayName = trimmed;
      await this.persist();
    }
    return this.getDeviceInfo();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(
        this.filePath,
        JSON.stringify(
          {
            deviceId: this.deviceId,
            displayName: this.displayName,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // ignore
    }
  }
}
