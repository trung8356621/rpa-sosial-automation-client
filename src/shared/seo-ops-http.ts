export class SeoOpsHttpError extends Error {
  constructor(
    readonly diagnostic: {
      method: string;
      endpoint: string;
      status: number;
      contentType: string;
      location?: string;
      retryAfterSeconds?: number;
      category:
        | "authentication"
        | "authorization"
        | "rate_limited"
        | "server_error"
        | "service_unavailable"
        | "network_error"
        | "redirect"
        | "unexpected_response";
      serverErrorCode?: string;
      serverErrorMessage?: string;
    }
  ) {
    super(
      `SEO_OPS_HTTP: ${diagnostic.method} ${diagnostic.endpoint} status=${diagnostic.status} category=${diagnostic.category}` +
        (diagnostic.serverErrorMessage ? ` msg=${diagnostic.serverErrorMessage}` : "") +
        (diagnostic.serverErrorCode ? ` code=${diagnostic.serverErrorCode}` : "")
    );
  }
}

export function formatClientHttpError(error: unknown): string {
  if (error instanceof SeoOpsHttpError) {
    const d = error.diagnostic;
    if (d.status === 401) {
      if (d.serverErrorCode === 'key_revoked') return "API Key đã bị thu hồi (Revoked). Vui lòng tạo key mới.";
      return "API Key không hợp lệ hoặc đã hết hạn (401 Unauthorized).";
    }
    if (d.status === 403) return "Quyền truy cập bị từ chối hoặc sai Installation (403 Forbidden).";
    if (d.status === 404) return "Endpoint không tồn tại (404 Not Found). Kiểm tra lại URL.";
    if (d.status === 429) return `Quá nhiều yêu cầu. Vui lòng thử lại sau ${d.retryAfterSeconds ?? 30}s.`;
    if (d.status >= 500) return `Máy chủ SEO-OPS gặp lỗi (${d.status}). Vui lòng kiểm tra backend.`;
    if (d.category === "network_error") return "Không thể kết nối đến máy chủ. Kiểm tra mạng hoặc endpoint.";
    return d.serverErrorMessage || error.message;
  }
  const msg = (error as Error)?.message || String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return "Không thể kết nối đến máy chủ. Endpoint không khả dụng.";
  }
  return msg;
}

export async function readSeoOpsJson(
  response: Response,
  method: string,
  url: string
): Promise<Record<string, unknown>> {
  const endpoint = new URL(url).pathname;
  const contentType = response.headers.get("content-type") ?? "";
  const locationRaw = response.headers.get("location") ?? undefined;
  const location = locationRaw
    ? (() => {
        try {
          return new URL(locationRaw, url).pathname;
        } catch {
          return "[invalid redirect]";
        }
      })()
    : undefined;

  const retryRaw = response.headers.get("retry-after");
  const retryAfterSeconds = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;

  const category =
    response.status === 401
      ? "authentication"
      : response.status === 403
        ? "authorization"
        : response.status === 429
          ? "rate_limited"
          : response.status === 503
            ? "service_unavailable"
            : response.status >= 500
              ? "server_error"
              : response.status >= 300 && response.status < 400
                ? "redirect"
                : "unexpected_response";

  let parsedBody: Record<string, unknown> | null = null;
  if (/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    try {
      parsedBody = (await response.json()) as Record<string, unknown>;
    } catch {
      // ignore JSON parse error
    }
  } else {
    await response.text().catch(() => "");
  }

  if (!response.ok) {
    const validationErrors = Array.isArray(parsedBody?.errors)
      ? parsedBody.errors.filter((item): item is string => typeof item === "string")
          .map((item) => item
            .replace(/Bearer\s+\S+|rpa_[A-Za-z0-9_-]+/gi, "[redacted]")
            .replace(/[^A-Za-z0-9_.:\[\]-]/g, "")
            .slice(0, 120))
          .filter(Boolean).slice(0, 5)
      : [];
    throw new SeoOpsHttpError({
      method,
      endpoint,
      status: response.status,
      contentType,
      location,
      retryAfterSeconds,
      category,
      serverErrorCode: typeof parsedBody?.error === "string" ? parsedBody.error : undefined,
      serverErrorMessage: typeof parsedBody?.message === "string"
        ? parsedBody.message.replace(/Bearer\s+\S+|rpa_[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 500)
        : validationErrors.length ? validationErrors.join(",") : undefined,
    });
  }

  if (!parsedBody) {
    throw new SeoOpsHttpError({
      method,
      endpoint,
      status: response.status,
      contentType,
      location,
      category: "unexpected_response",
    });
  }

  return parsedBody;
}
