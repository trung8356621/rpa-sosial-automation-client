/**
 * Preload for RPA WebContentsView only — isolated clipboard bridge.
 * Does not expose Node, credentials, or OS clipboard.
 */
import { contextBridge, ipcRenderer } from "electron";

const CHANNEL_WRITE = "rpa-browser-clipboard-write";
const CHANNEL_READ = "rpa-browser-clipboard-read";
const CHANNEL_WRITE_SYNC = "rpa-browser-clipboard-write-sync";
const CHANNEL_READ_SYNC = "rpa-browser-clipboard-read-sync";

contextBridge.exposeInMainWorld("__rpaIsolatedClipboard", {
  write(text: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(CHANNEL_WRITE, typeof text === "string" ? text : "");
  },
  read(): Promise<string> {
    return ipcRenderer.invoke(CHANNEL_READ);
  },
  writeSync(text: string): boolean {
    return Boolean(
      ipcRenderer.sendSync(CHANNEL_WRITE_SYNC, typeof text === "string" ? text : "")
    );
  },
  readSync(): string {
    const value = ipcRenderer.sendSync(CHANNEL_READ_SYNC);
    return typeof value === "string" ? value : "";
  },
});
