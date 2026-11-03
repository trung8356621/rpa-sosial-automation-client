import {
  Menu,
  ipcMain,
  type WebContents,
  type Event as ElectronEvent,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sharedBrowserVirtualClipboard,
  type BrowserVirtualClipboard,
} from "./browser-virtual-clipboard.js";
import {
  buildClipboardPagePatchScript,
  getSelectionHelpersSource,
  isIsolatedClipboardShortcut,
} from "./browser-clipboard-helpers.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

export {
  buildClipboardPagePatchScript,
  isIsolatedClipboardShortcut,
} from "./browser-clipboard-helpers.js";

const CHANNEL_WRITE = "rpa-browser-clipboard-write";
const CHANNEL_READ = "rpa-browser-clipboard-read";
const CHANNEL_WRITE_SYNC = "rpa-browser-clipboard-write-sync";
const CHANNEL_READ_SYNC = "rpa-browser-clipboard-read-sync";

const wcToBrowserId = new WeakMap<WebContents, string>();
let ipcRegistered = false;

export function resolveBrowserClipboardPreloadPath(): string {
  // dist/main/browser → dist/preload
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "preload", "browser-clipboard-preload.cjs");
}

export function registerBrowserClipboardIpc(
  store: BrowserVirtualClipboard = sharedBrowserVirtualClipboard
): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(CHANNEL_WRITE, (event, text: unknown) => {
    const browserId = wcToBrowserId.get(event.sender);
    if (!browserId || typeof text !== "string") return { ok: false };
    store.write(browserId, text);
    return { ok: true };
  });

  ipcMain.handle(CHANNEL_READ, (event) => {
    const browserId = wcToBrowserId.get(event.sender);
    if (!browserId) return "";
    return store.read(browserId);
  });

  ipcMain.on(CHANNEL_WRITE_SYNC, (event, text: unknown) => {
    const browserId = wcToBrowserId.get(event.sender);
    if (!browserId || typeof text !== "string") {
      event.returnValue = false;
      return;
    }
    store.write(browserId, text);
    event.returnValue = true;
  });

  ipcMain.on(CHANNEL_READ_SYNC, (event) => {
    const browserId = wcToBrowserId.get(event.sender);
    event.returnValue = browserId ? store.read(browserId) : "";
  });
}

async function readPageSelection(webContents: WebContents): Promise<string> {
  try {
    const helpers = getSelectionHelpersSource();
    const text = await webContents.executeJavaScript(
      `(function(){ ${helpers}; return __rpaGetSelectedText(); })()`,
      true
    );
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

async function deletePageSelection(webContents: WebContents): Promise<void> {
  try {
    const helpers = getSelectionHelpersSource();
    await webContents.executeJavaScript(
      `(function(){ ${helpers}; return __rpaDeleteSelection(); })()`,
      true
    );
  } catch {
    // ignore
  }
}

async function injectClipboardPatch(webContents: WebContents): Promise<void> {
  try {
    await webContents.executeJavaScript(buildClipboardPagePatchScript(), true);
  } catch (err) {
    logClientError("Failed to inject clipboard isolation patch", err);
  }
}

export type BrowserClipboardIsolationHandle = {
  browserId: string;
  dispose: () => void;
};

/**
 * Attach strongest isolation supported for an embedded RPA WebContentsView.
 * Does not install global keyboard hooks or mutate the OS clipboard.
 */
export function attachBrowserClipboardIsolation(
  webContents: WebContents,
  browserId: string,
  store: BrowserVirtualClipboard = sharedBrowserVirtualClipboard
): BrowserClipboardIsolationHandle {
  registerBrowserClipboardIpc(store);
  wcToBrowserId.set(webContents, browserId);

  const onBeforeInput = (event: ElectronEvent, input: Electron.Input) => {
    const action = isIsolatedClipboardShortcut({
      type: input.type,
      key: input.key,
      control: input.control,
      meta: input.meta,
      alt: input.alt,
      shift: input.shift,
    });
    if (!action) return;

    // Block Chromium's default OS clipboard pathway for this shortcut.
    event.preventDefault();

    void (async () => {
      try {
        if (action === "copy" || action === "cut") {
          const text = await readPageSelection(webContents);
          store.write(browserId, text);
          if (action === "cut" && text) {
            await deletePageSelection(webContents);
          }
          return;
        }
        if (action === "paste") {
          const text = store.read(browserId);
          if (!text) return;
          webContents.insertText(text);
        }
      } catch (err) {
        logClientError("Isolated clipboard shortcut failed", err);
      }
    })();
  };

  const onContextMenu = (
    _event: ElectronEvent,
    params: Electron.ContextMenuParams
  ) => {
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.selectionText || params.isEditable) {
      template.push({
        label: "Copy",
        enabled: Boolean(params.selectionText),
        click: () => {
          store.write(browserId, params.selectionText || "");
        },
      });
      template.push({
        label: "Cut",
        enabled: Boolean(params.isEditable && params.selectionText),
        click: () => {
          store.write(browserId, params.selectionText || "");
          void deletePageSelection(webContents);
        },
      });
      template.push({
        label: "Paste",
        enabled: Boolean(params.isEditable && store.read(browserId)),
        click: () => {
          const text = store.read(browserId);
          if (!text) return;
          webContents.insertText(text);
        },
      });
    }

    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup();
  };

  const onDomReady = () => {
    void injectClipboardPatch(webContents);
  };

  const onFinishLoad = () => {
    void injectClipboardPatch(webContents);
  };

  // Deny page permission prompts that target the system clipboard.
  try {
    const sess = webContents.session;
    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      if (
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write"
      ) {
        callback(false);
        return;
      }
      callback(true);
    });
    sess.setPermissionCheckHandler((_wc, permission) => {
      if (
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write"
      ) {
        return false;
      }
      return true;
    });
  } catch (err) {
    logClientError("Failed to set clipboard permission handlers", err);
  }

  webContents.on("before-input-event", onBeforeInput);
  webContents.on("context-menu", onContextMenu);
  webContents.on("dom-ready", onDomReady);
  webContents.on("did-finish-load", onFinishLoad);

  logClientEvent("Attached RPA browser clipboard isolation", { browserId });

  return {
    browserId,
    dispose: () => {
      try {
        webContents.removeListener("before-input-event", onBeforeInput);
        webContents.removeListener("context-menu", onContextMenu);
        webContents.removeListener("dom-ready", onDomReady);
        webContents.removeListener("did-finish-load", onFinishLoad);
      } catch {
        // webContents may already be destroyed
      }
      wcToBrowserId.delete(webContents);
      store.clear(browserId);
      logClientEvent("Disposed RPA browser clipboard isolation", { browserId });
    },
  };
}
