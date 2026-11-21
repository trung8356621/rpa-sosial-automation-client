import type { WebContents } from "electron";

export type CheckboxState = "checked" | "unchecked" | "unavailable";
export type CheckboxTargetKind = "wordpress_remember_me";
export type CheckboxInspectReason =
  | "ok"
  | "absent"
  | "ambiguous"
  | "origin_mismatch"
  | "form_mismatch"
  | "unavailable";

export interface CheckboxInspectResult {
  state: CheckboxState;
  reason: CheckboxInspectReason;
}

/**
 * Identify explicitly scoped checkbox targets (never applies to generic CLICK_TARGET steps).
 */
export function resolveCheckboxTargetKind(params: {
  action: string;
  stepName?: string;
  ocrText?: string;
}): CheckboxTargetKind | null {
  if (params.action !== "CLICK_TARGET") return null;
  const name = (params.stepName ?? "").trim().toLowerCase();
  const ocr = (params.ocrText ?? "").trim().toLowerCase();
  if (
    name === "remember" ||
    name === "remember_me" ||
    name === "remember me" ||
    ocr === "remember" ||
    ocr === "remember me"
  ) {
    return "wordpress_remember_me";
  }
  return null;
}

const WP_REMEMBER_ME_FIND_BODY = `
  var form = document.querySelector('#loginform, form[name="loginform"], form[action*="wp-login.php"]');
  var root = form || document;
  var candidates = Array.prototype.slice.call(
    root.querySelectorAll('#rememberme, input[type="checkbox"][name="rememberme"]')
  );
  if (candidates.length === 0) {
    var labels = Array.prototype.slice.call(root.querySelectorAll('label'));
    for (var i = 0; i < labels.length; i++) {
      if (/remember/i.test(labels[i].textContent || '')) {
        var cb = labels[i].querySelector('input[type="checkbox"]');
        if (!cb && labels[i].getAttribute('for')) {
          cb = document.getElementById(labels[i].getAttribute('for'));
        }
        if (cb && cb.type === 'checkbox' && candidates.indexOf(cb) === -1) {
          candidates.push(cb);
        }
      }
    }
  }
  if (candidates.length === 0) return { state: 'unavailable', reason: form ? 'absent' : 'form_mismatch' };
  if (candidates.length > 1) return { state: 'unavailable', reason: 'ambiguous' };
  var el = candidates[0];
  if (!el || typeof el.checked !== 'boolean') return { state: 'unavailable', reason: 'unavailable' };
  if (form && !form.contains(el)) return { state: 'unavailable', reason: 'form_mismatch' };
`;

const WP_REMEMBER_ME_INSPECT_SCRIPT = `(() => {
  try {
    ${WP_REMEMBER_ME_FIND_BODY}
    return { state: el.checked ? 'checked' : 'unchecked', reason: 'ok' };
  } catch (e) {
    return { state: 'unavailable', reason: 'unavailable' };
  }
})()`;

const WP_REMEMBER_ME_CHECK_SCRIPT = `(() => {
  try {
    ${WP_REMEMBER_ME_FIND_BODY}
    if (!el.checked) {
      el.click();
    }
    return { state: el.checked ? 'checked' : 'unchecked', reason: 'ok' };
  } catch (e) {
    return { state: 'unavailable', reason: 'unavailable' };
  }
})()`;

function matchesAuthorizedOrigin(
  webContents: Pick<WebContents, "getURL">,
  authorizedSiteUrl?: string | null
): boolean {
  if (!authorizedSiteUrl?.trim()) return true;
  try {
    const curRaw = typeof webContents.getURL === "function" ? webContents.getURL() : "";
    if (!curRaw) return false;
    const siteNorm = /^https?:\/\//i.test(authorizedSiteUrl.trim())
      ? authorizedSiteUrl.trim()
      : `https://${authorizedSiteUrl.trim()}`;
    return new URL(curRaw).origin === new URL(siteNorm).origin;
  } catch {
    return false;
  }
}

export async function inspectWordPressRememberMeContext(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript" | "getURL">,
  authorizedSiteUrl?: string | null
): Promise<CheckboxInspectResult> {
  try {
    if (!webContents || webContents.isDestroyed?.()) {
      return { state: "unavailable", reason: "unavailable" };
    }
    if (!matchesAuthorizedOrigin(webContents, authorizedSiteUrl)) {
      return { state: "unavailable", reason: "origin_mismatch" };
    }
    if (typeof webContents.executeJavaScript !== "function") {
      return { state: "unavailable", reason: "unavailable" };
    }
    const res = (await webContents.executeJavaScript(WP_REMEMBER_ME_INSPECT_SCRIPT, true)) as
      | { state?: string; reason?: string }
      | undefined;
    if (res && (res.state === "checked" || res.state === "unchecked")) {
      return { state: res.state, reason: "ok" };
    }
    const reason =
      res?.reason === "absent" ||
      res?.reason === "ambiguous" ||
      res?.reason === "form_mismatch"
        ? res.reason
        : "unavailable";
    return { state: "unavailable", reason };
  } catch {
    return { state: "unavailable", reason: "unavailable" };
  }
}

export async function inspectWordPressRememberMeCheckbox(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript" | "getURL">,
  authorizedSiteUrl?: string | null
): Promise<CheckboxState> {
  const res = await inspectWordPressRememberMeContext(webContents, authorizedSiteUrl);
  return res.state;
}

export async function checkWordPressRememberMeCheckbox(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript" | "getURL">,
  authorizedSiteUrl?: string | null
): Promise<boolean> {
  try {
    if (!webContents || webContents.isDestroyed?.()) return false;
    if (!matchesAuthorizedOrigin(webContents, authorizedSiteUrl)) return false;
    if (typeof webContents.executeJavaScript !== "function") return false;
    const res = (await webContents.executeJavaScript(WP_REMEMBER_ME_CHECK_SCRIPT, true)) as
      | { state?: string }
      | undefined;
    return res?.state === "checked";
  } catch {
    return false;
  }
}
