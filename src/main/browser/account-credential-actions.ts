/**
 * Helpers for toolbar credential actions (username / password).
 * Never treats Account UUID as a login identifier.
 * Never logs or persists plaintext passwords.
 */

export type LoginAccountFields = {
  username?: string | null;
  email?: string | null;
  accountId?: string | null;
};

/** Prefer username, then email. Never returns account UUID. */
export function resolveAccountLoginIdentifier(account: LoginAccountFields): string | null {
  const username = typeof account.username === "string" ? account.username.trim() : "";
  if (username) return username;
  const email = typeof account.email === "string" ? account.email.trim() : "";
  if (email) return email;
  return null;
}

export function buildAccountPasswordPath(accountId: string, browserId: string): string {
  const id = (accountId || "").trim();
  const browser = (browserId || "").trim();
  if (!id) {
    throw new Error("Thiếu Account ID — không thể lấy mật khẩu.");
  }
  if (!browser) {
    throw new Error("Cần Browser đang mở (browser_id) để lấy mật khẩu.");
  }
  return (
    `/api/v1/social-automation/client/accounts/${encodeURIComponent(id)}/password` +
    `?browser_id=${encodeURIComponent(browser)}`
  );
}
