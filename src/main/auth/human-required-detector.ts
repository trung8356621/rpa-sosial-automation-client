import type { WebContents } from "electron";
import { logClientEvent } from "../main-error-log.js";

export type HumanRequiredDetectionOutcome = "CONFIRMED" | "UNCERTAIN" | "NONE";

export type HumanRequiredDetectionResult = {
  outcome: HumanRequiredDetectionOutcome;
  ruleId: string;
  evidence: string;
};

/**
 * Isolated DOM-based human verification / CAPTCHA detector.
 * Retained for future opt-in or specialized workflows; NOT invoked in the
 * normal visual RPA step execution pipeline.
 */
export const HUMAN_REQUIRED_DETECTION_SCRIPT = `(() => {
  const queryAll = (sel) => {
    if (typeof document.querySelectorAll === 'function') {
      return Array.from(document.querySelectorAll(sel) || []);
    }
    const single = typeof document.querySelector === 'function' ? document.querySelector(sel) : null;
    return single ? [single] : [];
  };

  const getStyle = (el) =>
    el && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el)
      : null;

  const isNodeHidden = (node) => {
    if (!node) return false;
    if (node.classList?.contains('hidden')) return true;
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return true;
    if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return true;
    if (String(node.tagName || '').toUpperCase() === 'DIALOG' && node.open === false) return true;
    const style = getStyle(node);
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    ) {
      return true;
    }
    return false;
  };

  const inspectVisible = (el) => {
    if (!el) return { visible: false, reason: 'missing' };
    if (typeof el.isConnected === 'boolean' && !el.isConnected) {
      return { visible: false, reason: 'disconnected' };
    }
    let cur = el;
    let depth = 0;
    while (cur && depth < 32) {
      if (isNodeHidden(cur)) {
        return { visible: false, reason: 'hidden_or_inactive' };
      }
      cur = cur.parentElement || null;
      depth += 1;
    }
    if (typeof el.closest === 'function') {
      const wpWrap = el.closest('#wp-auth-check-wrap');
      if (wpWrap && isNodeHidden(wpWrap)) {
        return { visible: false, reason: 'wp_auth_check_wrap_hidden' };
      }
      const closedDialog = el.closest('dialog:not([open]), [aria-hidden="true"], .hidden, [hidden]');
      if (closedDialog && isNodeHidden(closedDialog)) {
        return { visible: false, reason: 'inactive_ancestor' };
      }
    }
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (rect && (rect.width <= 0 || rect.height <= 0)) {
      return { visible: false, reason: 'zero_size' };
    }
    const rectSummary = rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : 'no_rect';
    return { visible: true, reason: 'visible:' + rectSummary };
  };

  const isIgnoredAdminContext = (el) => {
    if (!el || typeof el.closest !== 'function') return false;
    return Boolean(
      el.closest('.notice, .notice-info, .notice-warning, .notice-error, .update-nag, #wpadminbar, #adminmenu, #titlewrap, #postdivrich, [contenteditable="true"]')
    );
  };

  // 1. WordPress interim login modal (#wp-auth-check) — only when actually visible.
  for (const wpAuth of queryAll('#wp-auth-check')) {
    const vis = inspectVisible(wpAuth);
    if (vis.visible) {
      return {
        outcome: 'CONFIRMED',
        ruleId: 'wp_auth_check_visible',
        evidence: 'selector=#wp-auth-check, ' + vis.reason,
      };
    }
  }

  // 2. Active CAPTCHA / challenge widgets — must be connected and visible.
  const challengeSelectors = [
    '#captcha',
    '.g-recaptcha',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '.h-captcha',
    '.cf-turnstile',
    '.cf-challenge',
    '#cf-challenge-running',
    '[data-callback*="captcha"]',
  ];
  for (const sel of challengeSelectors) {
    for (const el of queryAll(sel)) {
      if (isIgnoredAdminContext(el)) continue;
      const vis = inspectVisible(el);
      if (vis.visible) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_ui',
          evidence: 'selector=' + sel + ', ' + vis.reason,
        };
      }
    }
  }

  // 3. Context-aware challenge text inside visible active dialogs / challenge containers.
  const dialogSelectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    'dialog[open]',
    '.cf-challenge',
    '#challenge-form',
    '#challenge-stage',
  ];
  const strongChallengeRe = /verify you are human|complete the captcha|security check|human verification|please verify you/i;
  for (const sel of dialogSelectors) {
    for (const el of queryAll(sel)) {
      if (isIgnoredAdminContext(el)) continue;
      const vis = inspectVisible(el);
      if (!vis.visible) continue;
      const txt = String(el.innerText || el.textContent || '');
      if (strongChallengeRe.test(txt)) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_text_dialog',
          evidence: 'container=' + sel + ', ' + vis.reason,
        };
      }
    }
  }

  // 4. Standalone interstitial text (outside WordPress admin notices/editor/chrome).
  const body = document.body;
  if (body && typeof body.innerText === 'string') {
    const isWpAdminShell = Boolean(
      (typeof document.querySelector === 'function' && (document.querySelector('#wpadminbar') || document.querySelector('#wpcontent')))
    );
    if (!isWpAdminShell) {
      const bodyText = body.innerText.toLowerCase();
      if (bodyText.includes('verify you are human')) {
        return {
          outcome: 'CONFIRMED',
          ruleId: 'captcha_or_verification_text',
          evidence: 'standalone_interstitial=verify_you_are_human',
        };
      }
      if (bodyText.includes('captcha')) {
        return {
          outcome: 'UNCERTAIN',
          ruleId: 'weak_captcha_text_signal',
          evidence: 'standalone_text=captcha_without_visible_widget',
        };
      }
    }
  }

  return { outcome: 'NONE', ruleId: 'none', evidence: 'no_active_challenge' };
})()`;

export async function detectHumanRequired(
  webContents: WebContents,
  ctx?: { jobId?: string; attemptId?: string; stepIndex?: number }
): Promise<string | null> {
  try {
    const raw = await webContents.executeJavaScript(HUMAN_REQUIRED_DETECTION_SCRIPT, true);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const result = raw as Partial<HumanRequiredDetectionResult>;
    if (result.outcome === "CONFIRMED") {
      const ruleId = String(result.ruleId || "captcha_or_verification_ui");
      logClientEvent("HUMAN_REQUIRED_DETECTION", {
        jobId: ctx?.jobId ?? null,
        attemptId: ctx?.attemptId ?? null,
        stepIndex: ctx?.stepIndex ?? null,
        outcome: "CONFIRMED",
        ruleId,
        evidence: String(result.evidence || ""),
        blocked: true,
      });
      return `HUMAN_REQUIRED: phát hiện xác minh/CAPTCHA (${ruleId}) — không bypass.`;
    }
    if (result.outcome === "UNCERTAIN") {
      logClientEvent("HUMAN_REQUIRED_DETECTION", {
        jobId: ctx?.jobId ?? null,
        attemptId: ctx?.attemptId ?? null,
        stepIndex: ctx?.stepIndex ?? null,
        outcome: "UNCERTAIN",
        ruleId: String(result.ruleId || "ambiguous_signal"),
        evidence: String(result.evidence || ""),
        blocked: false,
      });
      return null;
    }
  } catch {
    // ignore detection failures
  }
  return null;
}
