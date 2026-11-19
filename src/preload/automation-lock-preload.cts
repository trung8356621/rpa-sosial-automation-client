/**
 * Preload for automation interaction-lock overlay only.
 * Exposes stop() — no Node, credentials, or Browser session access.
 */
import { contextBridge, ipcRenderer } from "electron";

const CHANNEL_STOP = "rpa-automation-lock-stop";

contextBridge.exposeInMainWorld("__rpaAutomationLock", {
  stop(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(CHANNEL_STOP);
  },
});
