import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import sharp, { type OverlayOptions } from "sharp";

export type FailureScreenshotStatus =
  | "captured"
  | "suppressed_sensitive_auth_screen"
  | "browser_unavailable"
  | "capture_failed";

export type FailureScreenshotArtifact = {
  status: FailureScreenshotStatus;
  kind: "failure_screenshot";
  job_id: string;
  attempt_id: string;
  error_code: string;
  mime_type: "image/png";
  sha256: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  local_path: string | null;
  url: string;
  redacted: boolean;
  captured_at: string;
  error_message?: string;
  outcome?: "success" | "failed";
  variant_id?: string;
  language_label?: string;
  package_key?: string;
  release_id?: number;
  priority?: number;
  screenshot_role?: string;
  failed_step?: number | string | null;
};

export type SensitiveRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SensitiveScreenProbe = {
  isLoginUrl: boolean;
  hasPasswordField: boolean;
  viewportWidth: number;
  viewportHeight: number;
  rects: SensitiveRect[];
};

const SENSITIVE_URL_RE = /\/(wp-login\.php|login|signin|sign-in|auth|oauth|sso)(\/|$)/i;

export function sanitizeArtifactUrl(rawUrl: string | undefined | null): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

export function isSensitiveAuthUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const u = new URL(rawUrl);
    return SENSITIVE_URL_RE.test(u.pathname);
  } catch {
    return SENSITIVE_URL_RE.test(rawUrl);
  }
}

function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

async function defaultInspectSensitiveScreen(wc: WebContents): Promise<SensitiveScreenProbe> {
  const rawUrl = wc.getURL();
  const isLoginUrl = isSensitiveAuthUrl(rawUrl);
  const probe = (await wc.executeJavaScript(
    `(() => {
      const vw = Math.max(1, window.innerWidth || 1024);
      const vh = Math.max(1, window.innerHeight || 560);
      const selectors = [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[autocomplete="new-password"]',
        'input[name*="pass" i]',
        'input[id*="pass" i]'
      ];
      const seen = new Set();
      const rects = [];
      let hasPasswordField = false;
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          hasPasswordField = true;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            rects.push({
              x: Math.max(0, Math.floor(r.left)),
              y: Math.max(0, Math.floor(r.top)),
              width: Math.ceil(r.width),
              height: Math.ceil(r.height),
            });
          }
        }
      }
      return { hasPasswordField, viewportWidth: vw, viewportHeight: vh, rects };
    })()`,
    true
  )) as {
    hasPasswordField: boolean;
    viewportWidth: number;
    viewportHeight: number;
    rects: SensitiveRect[];
  };

  return {
    isLoginUrl,
    hasPasswordField: Boolean(probe?.hasPasswordField),
    viewportWidth: Number(probe?.viewportWidth) || 1024,
    viewportHeight: Number(probe?.viewportHeight) || 560,
    rects: Array.isArray(probe?.rects) ? probe.rects : [],
  };
}

async function defaultCapturePage(wc: WebContents): Promise<Buffer> {
  const image = await wc.capturePage();
  return image.toPNG();
}

export async function redactSensitiveRects(
  pngBuffer: Buffer,
  rects: SensitiveRect[],
  viewportWidth: number,
  viewportHeight: number
): Promise<{ buffer: Buffer; width: number | null; height: number | null; redacted: boolean }> {
  const meta = await sharp(pngBuffer).metadata();
  const imgW = meta.width ?? null;
  const imgH = meta.height ?? null;
  if (!imgW || !imgH || rects.length === 0) {
    return { buffer: pngBuffer, width: imgW, height: imgH, redacted: false };
  }

  const scaleX = viewportWidth > 0 ? imgW / viewportWidth : 1;
  const scaleY = viewportHeight > 0 ? imgH / viewportHeight : 1;

  const overlays: OverlayOptions[] = [];
  for (const r of rects) {
    const left = Math.max(0, Math.min(imgW - 1, Math.floor(r.x * scaleX)));
    const top = Math.max(0, Math.min(imgH - 1, Math.floor(r.y * scaleY)));
    const w = Math.max(1, Math.min(imgW - left, Math.ceil(r.width * scaleX)));
    const h = Math.max(1, Math.min(imgH - top, Math.ceil(r.height * scaleY)));
    if (w <= 0 || h <= 0) continue;

    const maskSvg = Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="0" y="0" width="${w}" height="${h}" fill="#0f172a"/>` +
        `<text x="8" y="${Math.min(h - 4, Math.max(12, Math.floor(h * 0.65)))}" fill="#94a3b8" font-family="sans-serif" font-size="11">REDACTED</text>` +
        `</svg>`
    );
    overlays.push({ input: maskSvg, left, top });
  }

  if (overlays.length === 0) {
    return { buffer: pngBuffer, width: imgW, height: imgH, redacted: false };
  }

  const redactedBuffer = await sharp(pngBuffer).composite(overlays).png().toBuffer();
  return { buffer: redactedBuffer, width: imgW, height: imgH, redacted: true };
}

export async function captureAndPersistFailureScreenshot(params: {
  webContents: WebContents | undefined;
  jobId: string;
  attemptId: string;
  errorCode: string;
  artifactsDir: string;
  outcome?: "success" | "failed";
  variantId?: string;
  languageLabel?: string;
  packageKey?: string;
  releaseId?: number;
  priority?: number;
  screenshotRole?: string;
  failedStep?: number | string | null;
  capturePage?: (wc: WebContents) => Promise<Buffer>;
  inspectSensitiveScreen?: (wc: WebContents) => Promise<SensitiveScreenProbe>;
}): Promise<FailureScreenshotArtifact> {
  const capturedAt = new Date().toISOString();
  const wc = params.webContents;
  const variantMeta: Partial<FailureScreenshotArtifact> = {
    ...(params.outcome ? { outcome: params.outcome } : {}),
    ...(params.variantId ? { variant_id: params.variantId } : {}),
    ...(params.languageLabel ? { language_label: params.languageLabel } : {}),
    ...(params.packageKey ? { package_key: params.packageKey } : {}),
    ...(params.releaseId !== undefined ? { release_id: params.releaseId } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
    ...(params.screenshotRole ? { screenshot_role: params.screenshotRole } : {}),
    ...(params.failedStep !== undefined ? { failed_step: params.failedStep } : {}),
  };

  if (!wc || wc.isDestroyed()) {
    return {
      status: "browser_unavailable",
      kind: "failure_screenshot",
      job_id: params.jobId,
      attempt_id: params.attemptId,
      error_code: params.errorCode,
      mime_type: "image/png",
      sha256: null,
      size_bytes: null,
      width: null,
      height: null,
      local_path: null,
      url: "",
      redacted: false,
      captured_at: capturedAt,
      error_message: "WebContents unavailable or destroyed.",
      ...variantMeta,
    };
  }

  let rawUrl = "";
  try {
    rawUrl = wc.getURL();
  } catch {
    rawUrl = "";
  }
  const sanitizedUrl = sanitizeArtifactUrl(rawUrl);

  const inspectFn = params.inspectSensitiveScreen ?? defaultInspectSensitiveScreen;
  const captureFn = params.capturePage ?? defaultCapturePage;

  let probe: SensitiveScreenProbe | null = null;
  try {
    probe = await inspectFn(wc);
  } catch (err) {
    // If DOM inspection fails on a login/auth URL, suppress the raw image rather than risking credential exposure.
    if (isSensitiveAuthUrl(rawUrl) || params.errorCode === "AUTH_EXECUTION_FAILED") {
      return {
        status: "suppressed_sensitive_auth_screen",
        kind: "failure_screenshot",
        job_id: params.jobId,
        attempt_id: params.attemptId,
        error_code: params.errorCode,
        mime_type: "image/png",
        sha256: null,
        size_bytes: null,
        width: null,
        height: null,
        local_path: null,
        url: sanitizedUrl,
        redacted: true,
        captured_at: capturedAt,
        error_message: `Suppressed sensitive auth screen (probe failed: ${err instanceof Error ? err.message : String(err)})`,
        ...variantMeta,
      };
    }
  }

  try {
    const rawPng = await captureFn(wc);
    const rects = probe?.rects ?? [];
    const { buffer: finalPng, width, height, redacted } = await redactSensitiveRects(
      rawPng,
      rects,
      probe?.viewportWidth ?? 1024,
      probe?.viewportHeight ?? 560
    );

    await mkdir(params.artifactsDir, { recursive: true });
    const baseName = `${sanitizeFilenameSegment(params.jobId)}_${sanitizeFilenameSegment(params.attemptId)}`;
    const fileName =
      params.outcome === "success"
        ? `${baseName}_success.png`
        : params.variantId
          ? `${baseName}_v${params.priority ?? 0}_${sanitizeFilenameSegment(params.variantId)}.png`
          : `${baseName}.png`;
    const localPath = path.join(params.artifactsDir, fileName);
    await writeFile(localPath, finalPng);

    const sha256 = createHash("sha256").update(finalPng).digest("hex");
    return {
      status: "captured",
      kind: "failure_screenshot",
      job_id: params.jobId,
      attempt_id: params.attemptId,
      error_code: params.errorCode,
      mime_type: "image/png",
      sha256,
      size_bytes: finalPng.length,
      width,
      height,
      local_path: localPath,
      url: sanitizedUrl,
      redacted: redacted || Boolean(probe?.isLoginUrl && probe?.hasPasswordField),
      captured_at: capturedAt,
      ...variantMeta,
    };
  } catch (err) {
    return {
      status: "capture_failed",
      kind: "failure_screenshot",
      job_id: params.jobId,
      attempt_id: params.attemptId,
      error_code: params.errorCode,
      mime_type: "image/png",
      sha256: null,
      size_bytes: null,
      width: null,
      height: null,
      local_path: null,
      url: sanitizedUrl,
      redacted: false,
      captured_at: capturedAt,
      error_message: err instanceof Error ? err.message : String(err),
      ...variantMeta,
    };
  }
}
