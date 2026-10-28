export type OsFamily = "windows" | "linux" | "macos" | "other";

export interface OsMetadata {
  osFamily: OsFamily;
  osLabel: string;
  /** Wire/compat platform string (windows | linux | darwin | …). */
  platform: string;
  /** Diagnostic raw version string for support, not for UI title. */
  osVersion: string;
}

export interface OsMetadataInput {
  platform?: string;
  release?: string;
  type?: string;
  arch?: string;
  /** Result of os.version() when available. */
  version?: string;
  /** Contents of /etc/os-release when available. */
  linuxOsRelease?: string | null;
  /** ProductVersion from sw_vers when available. */
  macosProductVersion?: string | null;
}

function windowsLabel(release: string, version: string): string {
  const versionLower = version.toLowerCase();
  if (/\bwindows\s*11\b/.test(versionLower)) return "Windows 11";
  if (/\bwindows\s*10\b/.test(versionLower)) return "Windows 10";

  const buildMatch = /^10\.0\.(\d+)/.exec(release.trim());
  if (buildMatch) {
    const build = Number(buildMatch[1]);
    if (Number.isFinite(build) && build >= 22000) return "Windows 11";
    if (Number.isFinite(build) && build > 0) return "Windows 10";
  }

  if (/^6\.3\./.test(release) || /^6\.2\./.test(release)) return "Windows";
  return "Windows";
}

function parseLinuxOsRelease(contents: string | null | undefined): string | null {
  if (!contents || !contents.trim()) return null;
  const pretty = /^\s*PRETTY_NAME\s*=\s*(?:"([^"]+)"|([^\n\r]+))/m.exec(contents);
  const prettyName = (pretty?.[1] || pretty?.[2] || "").trim();
  if (prettyName) {
    // Keep short: "Ubuntu 24.04.1 LTS" → "Ubuntu 24.04" when possible
    const ubuntu = /^Ubuntu\s+(\d+\.\d+)/i.exec(prettyName);
    if (ubuntu) return `Ubuntu ${ubuntu[1]}`;
    return prettyName.length > 48 ? prettyName.slice(0, 48).trim() : prettyName;
  }

  const name = /^\s*NAME\s*=\s*(?:"([^"]+)"|([^\n\r]+))/m.exec(contents);
  const versionId = /^\s*VERSION_ID\s*=\s*(?:"([^"]+)"|([^\n\r]+))/m.exec(contents);
  const distro = (name?.[1] || name?.[2] || "").trim().replace(/^["']|["']$/g, "");
  const ver = (versionId?.[1] || versionId?.[2] || "").trim();
  if (distro && ver) return `${distro} ${ver}`.slice(0, 48);
  if (distro) return distro.slice(0, 48);
  return null;
}

function macosLabel(productVersion: string | null | undefined): string {
  const trimmed = (productVersion || "").trim();
  const major = /^(\d+)(?:\.\d+)*/.exec(trimmed);
  if (major) return `macOS ${major[1]}`;
  return "macOS";
}

/**
 * Normalize OS family + human label for register/heartbeat.
 * Does not guess versions when evidence is insufficient.
 */
export function detectOsMetadata(input: OsMetadataInput = {}): OsMetadata {
  const platformRaw = (input.platform || "").trim() || "unknown";
  const release = (input.release || "").trim();
  const type = (input.type || "").trim();
  const arch = (input.arch || "").trim();
  const version = (input.version || "").trim();
  const osVersion = [type || platformRaw, release, arch ? `(${arch})` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (platformRaw === "win32" || platformRaw === "windows") {
    return {
      osFamily: "windows",
      osLabel: windowsLabel(release, version),
      platform: "windows",
      osVersion: osVersion || version || "Windows",
    };
  }

  if (platformRaw === "linux") {
    const fromRelease = parseLinuxOsRelease(input.linuxOsRelease);
    return {
      osFamily: "linux",
      osLabel: fromRelease || "Linux",
      platform: "linux",
      osVersion: osVersion || "Linux",
    };
  }

  if (platformRaw === "darwin" || platformRaw === "macos") {
    return {
      osFamily: "macos",
      osLabel: macosLabel(input.macosProductVersion),
      platform: "darwin",
      osVersion: osVersion || "macOS",
    };
  }

  return {
    osFamily: "other",
    osLabel: platformRaw || "Other",
    platform: platformRaw,
    osVersion: osVersion || platformRaw || "Other",
  };
}
