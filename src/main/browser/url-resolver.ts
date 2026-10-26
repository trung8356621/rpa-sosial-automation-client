/**
 * Auto Open Website Resolver.
 * Resolves initial website URL based on Account platform and configured Site URL.
 * Strictly avoids falling back to facebook.com or general.com for other platforms.
 */

export function resolveInitialUrl(platform: string, siteUrl?: string | null): string {
  const normPlatform = (platform || "").toLowerCase().trim();

  // Known social platforms with standardized home URLs
  if (normPlatform === "facebook" || normPlatform === "fb") {
    return "https://www.facebook.com";
  }

  if (normPlatform === "threads") {
    return "https://www.threads.net";
  }

  if (normPlatform === "instagram" || normPlatform === "ig") {
    return "https://www.instagram.com";
  }

  if (normPlatform === "x" || normPlatform === "twitter") {
    return "https://x.com";
  }

  if (normPlatform === "tiktok") {
    return "https://www.tiktok.com";
  }

  // WordPress / custom / self-hosted platforms
  const hasSiteUrl = typeof siteUrl === "string" && siteUrl.trim().length > 0;
  if (hasSiteUrl) {
    let cleanUrl = siteUrl.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = `https://${cleanUrl}`;
    }
    try {
      const parsed = new URL(cleanUrl);
      if (["http:", "https:"].includes(parsed.protocol)) {
        return parsed.href;
      }
    } catch {
      // Invalid URL
    }
    throw new Error(`Site URL "${siteUrl}" không hợp lệ. Vui lòng kiểm tra lại cấu hình Account trên SEO-OPS.`);
  }

  if (normPlatform === "wordpress" || normPlatform === "wp" || normPlatform === "custom" || normPlatform === "website") {
    throw new Error(`Tài khoản nền tảng ${platform} yêu cầu cấu hình Site URL trên SEO-OPS.`);
  }

  throw new Error(`Không xác định được URL cho nền tảng "${platform}". Vui lòng cấu hình Site URL trên SEO-OPS.`);
}

/**
 * Auto-detects website / Browser Tag from the currently navigated URL.
 * Operates like RPA Admin: tags are inferred dynamically from active URL, not chosen manually.
 */
export function detectBrowserTagFromUrl(url: string): string {
  if (!url || typeof url !== "string") {
    return "unknown";
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host.includes("facebook.com") || host.includes("fb.com")) {
      return "facebook";
    }
    if (host.includes("threads.net")) {
      return "threads";
    }
    if (host.includes("instagram.com")) {
      return "instagram";
    }
    if (host.includes("x.com") || host.includes("twitter.com")) {
      return "x";
    }
    if (host.includes("tiktok.com")) {
      return "tiktok";
    }

    // Custom website / WordPress host
    return host.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
