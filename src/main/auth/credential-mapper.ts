import type { AuthScriptVariable } from "./auth-script-types.js";

export type AccountCredentialSource = {
  accountId: string;
  username?: string | null;
  email?: string | null;
  siteUrl?: string | null;
  getPassword: () => Promise<string>;
};

/**
 * Map Auth Script variable keys → values from approved Account credential APIs.
 * Never embeds secrets into script definitions; values are resolved at run time only.
 */
export async function resolveCredentialBindings(
  variables: AuthScriptVariable[],
  account: AccountCredentialSource
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; message: string }> {
  const values: Record<string, string> = {};
  let needsPassword = false;

  for (const variable of variables) {
    const key = (variable.key || "").trim();
    if (!key) continue;
    const normalized = key.toLowerCase();

    if (isPasswordKey(normalized)) {
      needsPassword = true;
      continue;
    }
    if (isUsernameKey(normalized)) {
      const user = (account.username || account.email || "").trim();
      if (!user) {
        return { ok: false, message: `Thiếu username/email cho biến ${key}` };
      }
      values[key] = user;
      continue;
    }
    if (isEmailKey(normalized)) {
      const email = (account.email || "").trim();
      if (!email) {
        return { ok: false, message: `Thiếu email cho biến ${key}` };
      }
      values[key] = email;
      continue;
    }
    if (isSiteUrlKey(normalized)) {
      const site = (account.siteUrl || "").trim();
      if (!site) {
        return { ok: false, message: `Thiếu site_url cho biến ${key}` };
      }
      values[key] = site;
      continue;
    }
    // Unknown non-secret variables stay unbound — runner may use literal step.value.
  }

  if (needsPassword) {
    let password: string;
    try {
      password = await account.getPassword();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Không lấy được password từ Client API",
      };
    }
    if (!password) {
      return { ok: false, message: "Account password trống" };
    }
    for (const variable of variables) {
      const key = (variable.key || "").trim();
      if (key && isPasswordKey(key.toLowerCase())) {
        values[key] = password;
      }
    }
  }

  return { ok: true, values };
}

export function isPasswordKey(normalized: string): boolean {
  return (
    normalized === "password" ||
    normalized === "pass" ||
    normalized === "user_pass" ||
    normalized === "passwd" ||
    normalized.endsWith("_password") ||
    normalized.endsWith(".password")
  );
}

function isUsernameKey(normalized: string): boolean {
  return (
    normalized === "username" ||
    normalized === "user" ||
    normalized === "user_login" ||
    normalized === "login" ||
    normalized === "log"
  );
}

function isEmailKey(normalized: string): boolean {
  return normalized === "email" || normalized === "user_email";
}

function isSiteUrlKey(normalized: string): boolean {
  return normalized === "site_url" || normalized === "siteurl" || normalized === "base_url";
}

/** Redact credential values from any object before logging. */
export function redactSecretsForLog(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") {
    if (input.length > 0 && input.length < 512) {
      // Never return raw-looking secrets in logs via this helper.
      return "[redacted-string]";
    }
    return "[redacted]";
  }
  if (Array.isArray(input)) return input.map((v) => redactSecretsForLog(v));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isPasswordKey(k.toLowerCase()) || /password|secret|token|credential/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = typeof v === "string" && v.length > 64 ? `[string:${v.length}]` : v;
      }
    }
    return out;
  }
  return input;
}
