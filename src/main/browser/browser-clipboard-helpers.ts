/** Clipboard shortcuts only — does not swallow other Ctrl chords. */
export function isIsolatedClipboardShortcut(input: {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}): "copy" | "cut" | "paste" | null {
  if (input.type !== "keyDown") return null;
  if (input.alt || input.shift) return null;
  if (!(input.control || input.meta)) return null;
  const key = input.key.toLowerCase();
  if (key === "c") return "copy";
  if (key === "x") return "cut";
  if (key === "v") return "paste";
  return null;
}

const SELECTION_HELPERS = `
function __rpaGetSelectedText() {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const input = el;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return String(input.value || "").slice(start, end);
    }
    return "";
  }
  try {
    return String(window.getSelection()?.toString() || "");
  } catch (_) {
    return "";
  }
}
function __rpaDeleteSelection() {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const input = el;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      const value = String(input.value || "");
      input.value = value.slice(0, start) + value.slice(end);
      input.setSelectionRange(start, start);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }
  try {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      sel.deleteFromDocument();
      return true;
    }
  } catch (_) {}
  return false;
}
`;

export function getSelectionHelpersSource(): string {
  return SELECTION_HELPERS;
}

/** Page-world patch: redirect clipboard APIs to the isolated bridge (never OS). */
export function buildClipboardPagePatchScript(): string {
  return `(() => {
  if (window.__rpaClipPatched) return true;
  const bridge = window.__rpaIsolatedClipboard;
  if (!bridge || typeof bridge.writeSync !== "function") return false;
  window.__rpaClipPatched = true;
  ${SELECTION_HELPERS}
  const writeSync = (t) => bridge.writeSync(String(t ?? ""));
  const readSync = () => String(bridge.readSync() ?? "");
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = (t) => Promise.resolve(writeSync(t)).then(() => undefined);
      navigator.clipboard.readText = () => Promise.resolve(readSync());
      navigator.clipboard.write = async (items) => {
        try {
          for (const item of items || []) {
            if (item && typeof item.getType === "function") {
              const blob = await item.getType("text/plain");
              if (blob) {
                writeSync(await blob.text());
                return;
              }
            }
          }
        } catch (_) {}
        writeSync("");
      };
      navigator.clipboard.read = async () => {
        const t = readSync();
        if (typeof ClipboardItem === "undefined") return [];
        return [new ClipboardItem({ "text/plain": new Blob([t], { type: "text/plain" }) })];
      };
    }
  } catch (_) {}
  try {
    const original = document.execCommand.bind(document);
    document.execCommand = (commandId, showUI, value) => {
      const cmd = String(commandId || "").toLowerCase();
      if (cmd === "copy" || cmd === "cut") {
        writeSync(__rpaGetSelectedText());
        if (cmd === "cut") __rpaDeleteSelection();
        return true;
      }
      if (cmd === "paste") {
        const text = readSync();
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          const input = el;
          const start = input.selectionStart ?? 0;
          const end = input.selectionEnd ?? 0;
          const cur = String(input.value || "");
          input.value = cur.slice(0, start) + text + cur.slice(end);
          const pos = start + text.length;
          input.setSelectionRange(pos, pos);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        try {
          return original("insertText", false, text);
        } catch (_) {
          return false;
        }
      }
      return original(commandId, showUI, value);
    };
  } catch (_) {}
  return true;
})()`;
}
