import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DeviceInfo } from "../../shared/contracts.js";
import { detectOsMetadata } from "../../shared/os-metadata.js";

const CLIENT_VERSION = "0.1.0";

function readLinuxOsRelease(): string | null {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return null;
  }
}

function readMacosProductVersion(): string | null {
  try {
    const out = execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    });
    const trimmed = String(out || "").trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function collectOsMetadata() {
  let version = "";
  try {
    version = os.version();
  } catch {
    version = "";
  }

  return detectOsMetadata({
    platform: process.platform,
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    version,
    linuxOsRelease: process.platform === "linux" ? readLinuxOsRelease() : null,
    macosProductVersion: process.platform === "darwin" ? readMacosProductVersion() : null,
  });
}

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

  getDeviceId(): string {
    if (!this.deviceId) {
      throw new Error("DeviceManager must be initialized before getDeviceId");
    }
    return this.deviceId;
  }

  getDeviceInfo(): DeviceInfo {
    if (!this.deviceId) {
      throw new Error("DeviceManager must be initialized before getDeviceInfo");
    }
    const osMeta = collectOsMetadata();
    return {
      deviceId: this.deviceId,
      displayName: this.displayName,
      platform: osMeta.platform,
      osVersion: osMeta.osVersion,
      osFamily: osMeta.osFamily,
      osLabel: osMeta.osLabel,
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
