import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

export type ManifestAsset = {
  path: string;
  sha256: string;
  kind?: string;
};

export type AssetFetchResult =
  | { ok: true; filePath: string; bytes: Buffer }
  | { ok: false; code: "ASSET_DOWNLOAD_UNAVAILABLE" | "ASSET_INTEGRITY_FAILED" | "ASSET_MISSING"; message: string };

export type AuthAssetDownloader = (params: {
  accountId: string;
  packageKey: string;
  version: string;
  releaseId: number;
  assetPath: string;
  expectedSha256: string;
}) => Promise<{ status: number; body: unknown }>;

function defaultAssetRoot(): string {
  try {
    // Lazy — unit tests may run without Electron app ready.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (app?.isReady?.()) return path.join(app.getPath("userData"), "orc-assets");
  } catch {
    /* ignore */
  }
  return path.join(process.cwd(), ".local", "orc-assets");
}

/**
 * Caches ROI/image assets by sha256 under userData.
 * Downloads via Client API adapter — fails closed when Addon contract is missing.
 */
export class OrcAssetStore {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? defaultAssetRoot();
  }

  cachePath(sha256: string, assetPath: string): string {
    const base = path.basename(assetPath).replace(/[^\w.\-]/g, "_") || "asset.bin";
    return path.join(this.root, sha256.slice(0, 2), sha256, base);
  }

  async ensureAssets(params: {
    accountId: string;
    packageKey: string;
    version: string;
    releaseId: number;
    assets: ManifestAsset[];
    download: AuthAssetDownloader;
  }): Promise<
    | { ok: true; byPath: Map<string, Buffer> }
    | { ok: false; code: string; message: string }
  > {
    const byPath = new Map<string, Buffer>();
    await mkdir(this.root, { recursive: true });

    for (const asset of params.assets) {
      const assetPath = String(asset.path || "").trim();
      const sha = String(asset.sha256 || "").trim().toLowerCase();
      if (!assetPath || !/^[a-f0-9]{64}$/.test(sha)) {
        return {
          ok: false,
          code: "ASSET_MISSING",
          message: `Manifest asset thiếu path/sha256 hợp lệ: ${assetPath || "(empty)"}`,
        };
      }

      const cached = this.cachePath(sha, assetPath);
      try {
        await access(cached);
        const bytes = await readFile(cached);
        const dig = createHash("sha256").update(bytes).digest("hex");
        if (dig !== sha) {
          return {
            ok: false,
            code: "ASSET_INTEGRITY_FAILED",
            message: `Cached asset sha256 mismatch for ${assetPath}`,
          };
        }
        byPath.set(assetPath, bytes);
        byPath.set(path.basename(assetPath), bytes);
        continue;
      } catch {
        // download
      }

      const res = await params.download({
        accountId: params.accountId,
        packageKey: params.packageKey,
        version: params.version,
        releaseId: params.releaseId,
        assetPath,
        expectedSha256: sha,
      });

      if (res.status === 404 || res.status === 501) {
        return {
          ok: false,
          code: "ASSET_DOWNLOAD_UNAVAILABLE",
          message: [
            "CONTRACT GAP: Client auth asset download endpoint missing.",
            "Need POST /api/v1/social-automation/client/auth/asset",
            "(same entitlement gates as auth/pull; return asset_base64 + sha256).",
            `Addon asset exists for Admin at /rpa-admin/scripts/asset but not for Client.`,
            `asset=${assetPath}`,
          ].join(" "),
        };
      }

      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          code: "ASSET_DOWNLOAD_UNAVAILABLE",
          message: `Asset download HTTP ${res.status} for ${assetPath}`,
        };
      }

      const body = res.body as Record<string, unknown>;
      const b64 =
        typeof body.asset_base64 === "string"
          ? body.asset_base64
          : typeof (body.data as { asset_base64?: string } | undefined)?.asset_base64 === "string"
            ? (body.data as { asset_base64: string }).asset_base64
            : null;
      if (!b64) {
        return {
          ok: false,
          code: "ASSET_DOWNLOAD_UNAVAILABLE",
          message: `Asset response missing asset_base64 for ${assetPath}`,
        };
      }
      const bytes = Buffer.from(b64, "base64");
      const dig = createHash("sha256").update(bytes).digest("hex");
      if (dig !== sha) {
        return {
          ok: false,
          code: "ASSET_INTEGRITY_FAILED",
          message: `Downloaded asset sha256 mismatch for ${assetPath}`,
        };
      }
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(cached, bytes);
      byPath.set(assetPath, bytes);
      byPath.set(path.basename(assetPath), bytes);
    }

    return { ok: true, byPath };
  }

  resolveTemplate(byPath: Map<string, Buffer>, asset: string): Buffer | null {
    const key = String(asset || "").trim();
    if (!key) return null;
    return byPath.get(key) ?? byPath.get(path.basename(key)) ?? null;
  }
}
