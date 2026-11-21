import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the official RPA Execution Client V2 icon path across dev and packaged builds.
 */
export function resolveAppIconPath(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const candidates =
    platform === "win32"
      ? [
          "rpa-automation-icon.ico",
          "rpa-automation-icon-256.png",
          "rpa-automation-icon.png",
        ]
      : [
          "rpa-automation-icon-512.png",
          "rpa-automation-icon-256.png",
          "rpa-automation-icon.png",
        ];

  const roots = [projectRoot];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    roots.push(process.resourcesPath);
  }

  for (const r of roots) {
    for (const file of candidates) {
      const full = path.join(r, "assets", file);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
