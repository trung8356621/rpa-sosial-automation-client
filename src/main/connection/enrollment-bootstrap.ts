/**
 * CP17A Staff enrollment bootstrap key shape detection.
 * Routing only — Laravel remains authority for signature/expiry/ownership.
 *
 * Format: rpa_client_{8hex}_{base64url(json)}.{hmac_sha256_hex}
 */

/** Opaque Bearer matching CP17A StaffClientEnrollmentBootstrap issue/parse. */
const ENROLLMENT_BOOTSTRAP_KEY_RE =
  /^rpa_client_[a-f0-9]{8}_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/i;

/**
 * True when the trimmed key *looks like* a staff enrollment bootstrap credential.
 * Not authentication proof — only selects connect routing (register-first).
 */
export function looksLikeEnrollmentBootstrapKey(rawKey: string): boolean {
  const key = rawKey.trim();
  if (!key) return false;
  return ENROLLMENT_BOOTSTRAP_KEY_RE.test(key);
}
