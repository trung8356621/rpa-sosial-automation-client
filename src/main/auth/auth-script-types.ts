/** Contract shapes for Client auth/resolve + auth/pull (CP8A OpenAPI). */

export interface AuthTagContext {
  actionTagId?: number;
  actionTagKey?: string;
}

export interface AuthReleaseIdentity {
  action_tag_id: number;
  action_tag_key: string;
  package_key: string;
  package_id: number;
  kind: string;
  is_authentication: boolean;
  version: string;
  release_id: number;
  content_digest: string;
  schema_version: number;
  status: string;
  runtime_compatibility?: Record<string, unknown> | null;
  assets_complete: boolean;
  ready_to_execute: boolean;
}

export interface AuthReleasePulled extends AuthReleaseIdentity {
  manifest: Record<string, unknown>;
}

export interface AuthResolveSuccess {
  ok: true;
  release: AuthReleaseIdentity;
}

export interface AuthPullSuccess {
  ok: true;
  release: AuthReleasePulled;
}

export type AuthScriptVariable = {
  id?: string;
  key: string;
  type?: string;
};

export type AuthScriptStep = {
  id?: string;
  action?: string;
  selector?: string;
  css?: string;
  url?: string;
  value?: string;
  variable?: string;
  variable_key?: string;
  ms?: number;
  timeout_ms?: number;
  target?: Record<string, unknown>;
  [key: string]: unknown;
};

export function hasExplicitTagContext(ctx?: AuthTagContext | null): boolean {
  if (!ctx) return false;
  if (typeof ctx.actionTagId === "number" && ctx.actionTagId > 0) return true;
  if (typeof ctx.actionTagKey === "string" && ctx.actionTagKey.trim().length > 0) return true;
  return false;
}

export function parseReleaseIdentity(raw: unknown): AuthReleaseIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const digest = typeof r.content_digest === "string" ? r.content_digest.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  if (typeof r.package_key !== "string" || !r.package_key) return null;
  if (typeof r.version !== "string" || !r.version) return null;
  const releaseId = Number(r.release_id);
  if (!Number.isFinite(releaseId) || releaseId < 1) return null;
  return {
    action_tag_id: Number(r.action_tag_id) || 0,
    action_tag_key: String(r.action_tag_key ?? ""),
    package_key: String(r.package_key),
    package_id: Number(r.package_id) || 0,
    kind: String(r.kind ?? "script"),
    is_authentication: Boolean(r.is_authentication),
    version: String(r.version),
    release_id: releaseId,
    content_digest: digest,
    schema_version: Number(r.schema_version) || 0,
    status: String(r.status ?? ""),
    runtime_compatibility:
      r.runtime_compatibility && typeof r.runtime_compatibility === "object"
        ? (r.runtime_compatibility as Record<string, unknown>)
        : null,
    assets_complete: Boolean(r.assets_complete),
    ready_to_execute: Boolean(r.ready_to_execute),
  };
}

export function parsePulledRelease(raw: unknown): AuthReleasePulled | null {
  const base = parseReleaseIdentity(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  if (!r.manifest || typeof r.manifest !== "object") return null;
  return { ...base, manifest: r.manifest as Record<string, unknown> };
}
