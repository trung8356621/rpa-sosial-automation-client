import type { WebContents } from "electron";

export type CheckboxState = "checked" | "unchecked" | "unavailable";
export type CheckboxTargetKind = "wordpress_remember_me";

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

const WP_REMEMBER_ME_INSPECT_SCRIPT = `(() => {
  try {
    var el = document.querySelector('#rememberme, input[type="checkbox"][name="rememberme"]');
    if (!el) {
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        if (/remember/i.test(labels[i].textContent || '')) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (!cb && labels[i].getAttribute('for')) {
            cb = document.getElementById(labels[i].getAttribute('for'));
          }
          if (cb && cb.type === 'checkbox') { el = cb; break; }
        }
      }
    }
    if (!el || typeof el.checked !== 'boolean') return 'unavailable';
    return el.checked ? 'checked' : 'unchecked';
  } catch (e) {
    return 'unavailable';
  }
})()`;

export async function inspectWordPressRememberMeCheckbox(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript">
): Promise<CheckboxState> {
  try {
    if (!webContents || webContents.isDestroyed?.()) return "unavailable";
    if (typeof webContents.executeJavaScript !== "function") return "unavailable";
    const res = await webContents.executeJavaScript(WP_REMEMBER_ME_INSPECT_SCRIPT, true);
    if (res === "checked" || res === "unchecked") return res;
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
