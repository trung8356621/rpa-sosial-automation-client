import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeLog } from "../src/main/main-error-log.js";
import { formatClientHttpError, SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

test("Log sanitization: never leaks API keys or Bearer tokens", () => {
  const secretKey = "rpa_client_dummy_sample_key_for_sanitization_test_only_00000";
  const rawLog = `Sent request with Bearer ${secretKey} to endpoint`;
  const sanitized = sanitizeLog(rawLog);

  assert.ok(!sanitized.includes(secretKey), "Must not include raw key");
  assert.ok(sanitized.includes("Bearer [REDACTED]"), "Must replace Bearer token");

  const queryLog = `Payload: apiKey: "${secretKey}" error`;
  const sanitizedQuery = sanitizeLog(queryLog);
  assert.ok(!sanitizedQuery.includes(secretKey), "Must not include raw apiKey in payload");
});

test("HttpError formatting: clear user-facing messages without leaking tokens", () => {
  const err401 = new SeoOpsHttpError({
    method: "GET",
    endpoint: "/api/v1/social-automation/client/validate",
    status: 401,
    contentType: "application/json",
    category: "authentication",
  });
  assert.strictEqual(formatClientHttpError(err401), "API Key không hợp lệ hoặc đã hết hạn (401 Unauthorized).");

  const errRevoked = new SeoOpsHttpError({
    method: "GET",
    endpoint: "/api/v1/social-automation/client/validate",
    status: 401,
    contentType: "application/json",
    category: "authentication",
    serverErrorCode: "key_revoked",
  });
  assert.strictEqual(formatClientHttpError(errRevoked), "API Key đã bị thu hồi (Revoked). Vui lòng tạo key mới.");

  const netErr = new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  assert.strictEqual(formatClientHttpError(netErr), "Không thể kết nối đến máy chủ. Endpoint không khả dụng.");
});
