/**
 * Client Campaign Job contracts (CP19A + Client Action Script APIs).
 *
 * Live deploy (seo-ops.duckdns.org) exposes:
 *   POST /api/v1/social-automation/client/scripts/pull
 *   POST /api/v1/social-automation/client/scripts/asset
 * GitHub openapi.yaml @5554eda still lags — do not treat that commit as source of truth.
 */
import {
  parseExecutionContext,
  type AuthExecutionContext,
} from "../auth/auth-script-types.js";

export type CampaignRunMode = "test" | "live";
export type CampaignExecutionMode = "one_account_one_job" | "one_account_many_jobs";
export type CampaignJobResultStatus = "succeeded" | "failed" | "cancelled" | "unknown";

export type CampaignScriptVariantCandidate = {
  variant_id?: string;
  priority?: number;
  language_label?: string;
  package_id?: number;
  package_key?: string;
  release_id?: number;
  script_version?: string;
  version?: string;
  content_digest?: string;
  execution_digest?: string;
};

export type CampaignScriptVariant = {
  variant_id: string;
  priority: number;
  language_label: string;
  package_id?: number;
  package_key: string;
  release_id: number;
  script_version: string;
  content_digest: string;
  execution_digest: string;
};

export type CampaignFallbackPolicy = {
  allowed_only_on: string;
  single_attempt_identity: boolean;
  success_screenshots: number;
  failure_screenshots_per_attempted_variant: number;
};

export type CampaignPreferredVariant = {
  variant_id?: string;
  language_label?: string;
  package_key?: string;
  release_id?: number;
};

/**
 * Claim payload. Exact script pin fields are required before pull/execute:
 * package_key (=script_id), version, release_id, content_digest, execution_digest.
 *
 * Digests are distinct:
 * - content_digest: package/content identity
 * - execution_digest: execution payload identity (never swap with content_digest)
 */
export type CampaignJobClaim = {
  plan_version?: number;
  plan_tag_id?: number;
  action_tag_key?: string;
  site_key?: string;
  job_id: string;
  attempt_id: string;
  campaign_id: string;
  content_id: string;
  browser_id: string;
  account_id: string;
  /** Package key (Addon: campaign.script_id → job.package_key). */
  script_id: string;
  script_version: string;
  package_key?: string;
  package_id?: number;
  version?: string;
  run_mode: CampaignRunMode;
  execution_mode: CampaignExecutionMode;
  input: Record<string, unknown>;
  lease_token: string;
  lease_expires_at: string;
  release_id?: number;
  content_digest?: string;
  execution_digest?: string;
  execution_context?: AuthExecutionContext;
  variant_group_id?: string;
  script_variants?: CampaignScriptVariantCandidate[];
  fallback_policy?: CampaignFallbackPolicy;
  preferred_variant_id?: string;
  preferred_language_label?: string;
  preferred_variant?: CampaignPreferredVariant | string;
};

export type CampaignJobAckRequest = {
  attempt_id: string;
  lease_token: string;
};

export type CampaignJobProgressRequest = {
  attempt_id: string;
  lease_token: string;
  message?: string;
  percent?: number;
  step?: string;
};

export type CampaignJobResultRequest = {
  attempt_id: string;
  lease_token: string;
  status: CampaignJobResultStatus;
  output?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  artifacts?: Array<Record<string, unknown>>;
};

export type CampaignJobArtifactUploadRequest = {
  attempt_uuid: string;
  lease_token?: string;
  kind: "screenshot";
  mime: string;
  outcome: "success" | "failed";
  phase: string;
  content_base64: string;
  checksum_sha256?: string;
  variant_id?: string;
  language_label?: string;
  package_key?: string;
  release_id?: number;
  priority?: number;
  screenshot_role?: string;
  step?: string | number;
};

export type CampaignJobArtifactUploadResponse = {
  artifact_uuid: string;
  checksum_sha256: string | null;
};

export type CampaignJobApiResult<T> =
  | { ok: true; data: T; idempotent?: boolean }
  | { ok: false; status: number; errors: string[]; message: string };

export type CampaignScriptContractGap = {
  code: "CONTRACT_GAP_SCRIPT_PULL" | "CONTRACT_GAP_SCRIPT_ASSET" | "CONTRACT_GAP_CLAIM_PIN";
  missing: string[];
  message: string;
};

export type CampaignScriptPin = {
  package_key: string;
  version: string;
  release_id: number;
  content_digest: string;
  execution_digest: string;
};

export const REQUIRED_CAMPAIGN_SCRIPT_APIS = [
  "POST /api/v1/social-automation/client/scripts/pull",
  "POST /api/v1/social-automation/client/scripts/asset",
] as const;

/** Live Action Script APIs are deployed (route returns 401 without key, not 404). */
export const CAMPAIGN_SCRIPT_APIS_AVAILABLE = true;

export function parseCampaignJobClaim(raw: unknown): CampaignJobClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const job_id = str(r.job_id);
  const attempt_id = str(r.attempt_id);
  const browser_id = str(r.browser_id);
  const account_id = str(r.account_id);
  const rawScriptId = str(r.script_id);
  const rawPackageKey = str(r.package_key);
  if (rawScriptId && rawPackageKey && rawScriptId !== rawPackageKey) {
    return null;
  }
  const script_id = rawScriptId || rawPackageKey;

  const rawScriptVersion = str(r.script_version);
  const rawVersion = str(r.version);
  if (rawScriptVersion && rawVersion && rawScriptVersion !== rawVersion) {
    return null;
  }
  const script_version = rawScriptVersion || rawVersion || str(r.package_version);
  const lease_token = str(r.lease_token);
  if (!job_id || !attempt_id || !browser_id || !account_id || !script_id || !script_version || !lease_token) {
    return null;
  }
  const run_mode = r.run_mode === "test" ? "test" : "live";
  const execution_mode =
    r.execution_mode === "one_account_one_job" ? "one_account_one_job" : "one_account_many_jobs";
  const input =
    r.input && typeof r.input === "object" && !Array.isArray(r.input)
      ? (r.input as Record<string, unknown>)
      : {};
  const script_variants = parseScriptVariants(r.script_variants);
  const fallback_policy = parseFallbackPolicy(r.fallback_policy);
  const policyObj =
    r.fallback_policy && typeof r.fallback_policy === "object" && !Array.isArray(r.fallback_policy)
      ? (r.fallback_policy as Record<string, unknown>)
      : null;
  const preferred_variant_id =
    str(r.preferred_variant_id) || str(policyObj?.preferred_variant_id) || undefined;
  const preferred_language_label =
    str(r.preferred_language_label) ||
    str(r.preferred_language) ||
    str(policyObj?.preferred_language_label) ||
    str(policyObj?.preferred_language) ||
    undefined;
  const preferred_variant = parsePreferredVariant(
    r.preferred_variant ?? r.variant_preference ?? policyObj?.preferred_variant ?? policyObj?.variant_preference
  );
  return {
    plan_version: posInt(r.plan_version),
    plan_tag_id: posInt(r.plan_tag_id),
    action_tag_key: str(r.action_tag_key) || undefined,
    site_key: str(r.site_key) || undefined,
    job_id,
    attempt_id,
    campaign_id: str(r.campaign_id) || "",
    content_id: str(r.content_id) || "",
    browser_id,
    account_id,
    script_id,
    script_version,
    package_key: rawPackageKey || undefined,
    package_id: posInt(r.package_id),
    version: rawVersion || undefined,
    run_mode,
    execution_mode,
    input,
    lease_token,
    lease_expires_at: str(r.lease_expires_at) || "",
    release_id: posInt(r.release_id),
    content_digest: digestHex(r.content_digest) || undefined,
    execution_digest: digestHex(r.execution_digest) || undefined,
    execution_context: parseExecutionContext(r.execution_context, r.resolved_url),
    variant_group_id: str(r.variant_group_id) || undefined,
    ...(script_variants ? { script_variants } : {}),
    ...(fallback_policy ? { fallback_policy } : {}),
    ...(preferred_variant_id ? { preferred_variant_id } : {}),
    ...(preferred_language_label ? { preferred_language_label } : {}),
    ...(preferred_variant !== undefined ? { preferred_variant } : {}),
  };
}

function parseScriptVariants(raw: unknown): CampaignScriptVariantCandidate[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: CampaignScriptVariantCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.push({});
      continue;
    }
    const v = item as Record<string, unknown>;
    const priorityRaw = v.priority;
    const priority =
      typeof priorityRaw === "number" && Number.isInteger(priorityRaw)
        ? priorityRaw
        : typeof priorityRaw === "string" && priorityRaw.trim() !== "" && Number.isInteger(Number(priorityRaw))
          ? Number(priorityRaw)
          : undefined;
    out.push({
      variant_id: str(v.variant_id) || undefined,
      priority,
      language_label: str(v.language_label) || undefined,
      package_id: posInt(v.package_id),
      package_key: str(v.package_key) || str(v.script_id) || undefined,
      release_id: posInt(v.release_id),
      script_version: str(v.script_version) || str(v.version) || undefined,
      version: str(v.version) || undefined,
      content_digest: digestHex(v.content_digest) || undefined,
      execution_digest: digestHex(v.execution_digest) || undefined,
    });
  }
  return out;
}

function parseFallbackPolicy(raw: unknown): CampaignFallbackPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const allowed_only_on = str(p.allowed_only_on);
  if (!allowed_only_on) return undefined;
  return {
    allowed_only_on,
    single_attempt_identity: p.single_attempt_identity !== false,
    success_screenshots: posInt(p.success_screenshots) ?? 1,
    failure_screenshots_per_attempted_variant:
      posInt(p.failure_screenshots_per_attempted_variant) ?? 1,
  };
}

function parsePreferredVariant(raw: unknown): CampaignPreferredVariant | string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    return s || undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (p.release_id !== undefined && p.release_id !== null && !posInt(p.release_id)) {
    return undefined;
  }
  const variant_id = str(p.variant_id) || undefined;
  const language_label = str(p.language_label) || str(p.language) || undefined;
  const package_key = str(p.package_key) || str(p.script_id) || undefined;
  const release_id = posInt(p.release_id);
  if (!variant_id && !language_label && !package_key && release_id === undefined) {
    return undefined;
  }
  return {
    ...(variant_id ? { variant_id } : {}),
    ...(language_label ? { language_label } : {}),
    ...(package_key ? { package_key } : {}),
    ...(release_id !== undefined ? { release_id } : {}),
  };
}

/** Exact pin required for a single script variant. Never allow unpinned variants. */
export function resolveVariantScriptPin(
  variant: CampaignScriptVariantCandidate
): CampaignScriptVariant | null {
  const variant_id = str(variant.variant_id);
  const language_label = str(variant.language_label);
  const package_key = str(variant.package_key);
  const script_version = str(variant.script_version) || str(variant.version);
  const release_id = posInt(variant.release_id);
  const content_digest = digestHex(variant.content_digest);
  const execution_digest = digestHex(variant.execution_digest);
  const priority =
    typeof variant.priority === "number" && Number.isInteger(variant.priority)
      ? variant.priority
      : undefined;
  if (
    !variant_id ||
    !language_label ||
    !package_key ||
    !script_version ||
    !release_id ||
    !content_digest ||
    !execution_digest ||
    priority === undefined
  ) {
    return null;
  }
  return {
    variant_id,
    priority,
    language_label,
    ...(variant.package_id ? { package_id: variant.package_id } : {}),
    package_key,
    release_id,
    script_version,
    content_digest,
    execution_digest,
  };
}

export function variantToScriptPin(variant: CampaignScriptVariant): CampaignScriptPin {
  return {
    package_key: variant.package_key,
    version: variant.script_version,
    release_id: variant.release_id,
    content_digest: variant.content_digest,
    execution_digest: variant.execution_digest,
  };
}

export type ResolvedScriptVariantsResult = {
  variants: CampaignScriptVariant[];
  preference: {
    provided: boolean;
    matched: boolean;
    reason: string;
    preferredVariantId: string | null;
    preferredLanguageLabel: string | null;
  };
};

/**
 * Validate and sort claim.script_variants by ascending priority, then apply
 * Backend's preferred variant (if provided and matching a pinned, compatible candidate).
 * Returns null if any variant is unpinned/invalid (fail-closed: never fetch unpinned releases).
 */
export function resolveScriptVariantsWithPreference(
  claim: CampaignJobClaim
): ResolvedScriptVariantsResult | null {
  if (!Array.isArray(claim.script_variants) || claim.script_variants.length === 0) {
    return null;
  }
  const validated: CampaignScriptVariant[] = [];
  for (const raw of claim.script_variants) {
    const v = resolveVariantScriptPin(raw);
    if (!v) return null;
    validated.push(v);
  }
  validated.sort((a, b) => a.priority - b.priority);

  const prefObj =
    claim.preferred_variant && typeof claim.preferred_variant === "object"
      ? claim.preferred_variant
      : null;
  const prefString =
    typeof claim.preferred_variant === "string" ? str(claim.preferred_variant) : "";
  const prefVariantId = str(claim.preferred_variant_id) || str(prefObj?.variant_id);
  const prefLang = str(claim.preferred_language_label) || str(prefObj?.language_label);
  const prefPkgKey = str(prefObj?.package_key);
  const prefReleaseId = prefObj?.release_id;

  const hasPreference = Boolean(
    prefVariantId || prefLang || prefPkgKey || prefReleaseId !== undefined || prefString
  );
  if (!hasPreference) {
    return {
      variants: validated,
      preference: {
        provided: false,
        matched: false,
        reason: "none",
        preferredVariantId: null,
        preferredLanguageLabel: null,
      },
    };
  }

  const matchedIdx = validated.findIndex((v) => {
    if (prefVariantId && v.variant_id !== prefVariantId) return false;
    if (prefLang && v.language_label.toUpperCase() !== prefLang.toUpperCase()) return false;
    if (prefPkgKey && v.package_key !== prefPkgKey) return false;
    if (prefReleaseId !== undefined && v.release_id !== prefReleaseId) return false;
    if (prefString && !prefVariantId && !prefLang) {
      const matchesId = v.variant_id === prefString;
      const matchesLang = v.language_label.toUpperCase() === prefString.toUpperCase();
      if (!matchesId && !matchesLang) return false;
    }
    return true;
  });

  if (matchedIdx < 0) {
    return {
      variants: validated,
      preference: {
        provided: true,
        matched: false,
        reason: "no_compatible_pinned_candidate",
        preferredVariantId: prefVariantId || null,
        preferredLanguageLabel: prefLang || prefString || null,
      },
    };
  }

  const ordered =
    matchedIdx === 0
      ? validated
      : [
          validated[matchedIdx],
          ...validated.slice(0, matchedIdx),
          ...validated.slice(matchedIdx + 1),
        ];

  return {
    variants: ordered,
    preference: {
      provided: true,
      matched: true,
      reason: matchedIdx === 0 ? "already_first" : "promoted_to_first",
      preferredVariantId: ordered[0].variant_id,
      preferredLanguageLabel: ordered[0].language_label,
    },
  };
}

/**
 * Validate and sort claim.script_variants by ascending priority (honoring preferred variant).
 * Returns null if any variant is unpinned/invalid (fail-closed: never fetch unpinned releases).
 */
export function resolveOrderedScriptVariants(
  claim: CampaignJobClaim
): CampaignScriptVariant[] | null {
  return resolveScriptVariantsWithPreference(claim)?.variants ?? null;
}

/** Exact pin required before Action Script pull. */
export function resolveClaimScriptPin(claim: CampaignJobClaim): CampaignScriptPin | null {
  const content_digest = digestHex(claim.content_digest);
  const execution_digest = digestHex(claim.execution_digest);
  const release_id = claim.release_id;
  if (!content_digest || !execution_digest) return null;
  if (!release_id || release_id < 1) return null;
  if (!claim.script_id || !claim.script_version) return null;
  // Never treat digests as interchangeable.
  if (content_digest === execution_digest) {
    // Same value is allowed only if Addon truly emits equal digests; still keep fields distinct in checks.
  }
  return {
    package_key: claim.script_id,
    version: claim.script_version,
    release_id,
    content_digest,
    execution_digest,
  };
}

export function campaignScriptContractGap(
  code: CampaignScriptContractGap["code"] = "CONTRACT_GAP_SCRIPT_PULL",
  missing: string[] = [...REQUIRED_CAMPAIGN_SCRIPT_APIS]
): CampaignScriptContractGap {
  return {
    code,
    missing,
    message:
      "CONTRACT GAP: Client Campaign Job needs Action Script pull/asset + exact claim pin " +
      "(release_id, content_digest, execution_digest). Do not use /client/auth/* for Action Scripts.",
  };
}

export function claimPinGap(): CampaignScriptContractGap {
  return campaignScriptContractGap("CONTRACT_GAP_CLAIM_PIN", [
    "CampaignJobClaim.release_id",
    "CampaignJobClaim.content_digest",
    "CampaignJobClaim.execution_digest",
  ]);
}

/** @deprecated Use resolveClaimScriptPin — content_digest only is insufficient. */
export function resolveClaimDigest(claim: CampaignJobClaim): string | null {
  return digestHex(claim.content_digest);
}

function posInt(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Verify claim.site_key against an Account/Profile siteUrl without weakening domain checks.
 * Accepts domain keys (e.g. "maytuicanvas.com") or URL keys ("https://maytuicanvas.com/").
 */
export function doesSiteKeyMatchSiteUrl(siteKey: string, siteUrl?: string | null): boolean {
  const rawKey = siteKey.trim().toLowerCase();
  const rawUrl = (siteUrl ?? "").trim().toLowerCase();
  if (!rawKey || !rawUrl) return true;

  const hostFrom = (val: string): string => {
    try {
      const withScheme = /^https?:\/\//.test(val) ? val : `https://${val}`;
      return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return val.replace(/^www\./, "");
    }
  };

  const keyHost = hostFrom(rawKey);
  const urlHost = hostFrom(rawUrl);
  if (!keyHost || !urlHost) return true;

  if (rawKey === "qa_sandbox_facebook") {
    return urlHost === "rpa-web-test.pages.dev" || urlHost.endsWith(".rpa-web-test.pages.dev");
  }

  if (keyHost.includes(".")) {
    return keyHost === urlHost;
  }
  return urlHost === keyHost || urlHost.startsWith(`${keyHost}.`);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function digestHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(d) ? d : null;
}
