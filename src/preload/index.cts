import { contextBridge, ipcRenderer } from "electron";
import type { ClientCommand, ConnectionState, BrowserStateSnapshot } from "../shared/contracts.js";

contextBridge.exposeInMainWorld("client", {
  invoke: (command: ClientCommand) => ipcRenderer.invoke("client:command", command),
  onStateChange: (callback: (state: ConnectionState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ConnectionState) => callback(state);
    ipcRenderer.on("client:state-change", handler);
    return () => ipcRenderer.removeListener("client:state-change", handler);
  },
  onBrowserStateChange: (callback: (state: BrowserStateSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserStateSnapshot) => callback(state);
    ipcRenderer.on("client:browser-state-change", handler);
    return () => ipcRenderer.removeListener("client:browser-state-change", handler);
  },
  onLog: (callback: (entry: { time: string; level: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: { time: string; level: string; message: string }) => callback(entry);
    ipcRenderer.on("client:log", handler);
    return () => ipcRenderer.removeListener("client:log", handler);
  },
});
