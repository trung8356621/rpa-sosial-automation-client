import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

/**
 * Host metadata only (display name + OS).
 * Client identity is the Client API Key — no Device UUID is generated or sent.
 */
export class DeviceManager {
  private filePath: string;
  private displayName: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "host-meta.json");
    this.displayName = os.hostname() || "Windows Desktop Client";
  }

  async initialize(): Promise<DeviceInfo> {
    // Migrate legacy device.json displayName if present; ignore legacy deviceId.
    try {
      const legacyPath = path.join(path.dirname(this.filePath), "device.json");
      const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
      if (typeof legacy.displayName === "string" && legacy.displayName.trim()) {
        this.displayName = legacy.displayName.trim();
      }
    } catch {
      // no legacy file
    }

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      if (typeof parsed.displayName === "string" && parsed.displayName.trim()) {
        this.displayName = parsed.displayName.trim();
      }
    } catch {
      // Not initialized yet
    }

    await this.persist();
    return this.getDeviceInfo();
  }

  getDeviceInfo(): DeviceInfo {
    const osMeta = collectOsMetadata();
    return {
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
        JSON.stringify({ displayName: this.displayName }, null, 2),
        "utf8"
      );
    } catch {
      // ignore
    }
  }
}
