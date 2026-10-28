import type { SessionSignal } from "./contracts.js";

export interface RemoteSessionSignal {
  browser_id: string;
  present?: boolean;
  status?: string;
  checked_at?: string | null;
  method?: string | null;
}

/** Canonical boolean: green only when present===true or status==="present". */
export function signalIsPresent(signal: Pick<SessionSignal, "status"> | { present?: boolean; status?: string } | null | undefined): boolean {
  if (!signal) return false;
  if (typeof (signal as { present?: boolean }).present === "boolean") {
    return Boolean((signal as { present?: boolean }).present);
  }
  return signal.status === "present";
}

export function normalizeSessionSignal(raw: {
  present?: boolean | null;
  status?: string | null;
  checked_at?: string | null;
  checkedAt?: string | null;
  method?: string | null;
  error?: string | null;
} | null | undefined): SessionSignal {
  const checkedAt = raw?.checkedAt ?? raw?.checked_at ?? null;
  const present = typeof raw?.present === "boolean"
    ? raw.present
    : raw?.status === "present";
  const method = (raw?.method as SessionSignal["method"]) ?? null;
  return {
    status: present ? "present" : "absent",
    checkedAt: checkedAt ? String(checkedAt) : null,
    method,
    error: raw?.error ?? null,
  };
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Last-writer-wins by checked_at. Equal timestamps prefer incoming.
 * Missing timestamps lose to any explicit timestamp.
 */
export function mergeSessionSignalLastWriteWins(
  current: SessionSignal | null | undefined,
  incoming: SessionSignal | null | undefined,
): SessionSignal {
  const cur = normalizeSessionSignal(current ?? null);
  const next = normalizeSessionSignal(incoming ?? null);
  const curTs = timestampMs(cur.checkedAt);
  const nextTs = timestampMs(next.checkedAt);
  if (nextTs === null && curTs === null) return next;
  if (nextTs === null) return cur;
  if (curTs === null) return next;
  return nextTs >= curTs ? next : cur;
}

export function shouldApplyRemoteSignal(
  local: SessionSignal | null | undefined,
  remote: SessionSignal,
): boolean {
  const merged = mergeSessionSignalLastWriteWins(local, remote);
  const localNorm = normalizeSessionSignal(local ?? null);
  return merged.status !== localNorm.status || merged.checkedAt !== localNorm.checkedAt;
}
