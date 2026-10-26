import { app, BrowserWindow, ipcMain, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeMainLogging, logClientError, logClientEvent, setLogListener } from "./main-error-log.js";
import { ClientStore } from "./storage/store.js";
import { ClientCredentialStore } from "./storage/credential-store.js";
import { DeviceManager } from "./device/device-manager.js";
import { ClientConnection } from "./connection/client-connection.js";
import { TrayManager } from "./app/tray-manager.js";
import type { ClientCommand } from "../shared/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(root, "..");

// Windows userData is strictly isolated to .local/client (never .local/creator)
const userDataPath = path.join(project, ".local", "client");
app.setPath("userData", userDataPath);
app.setPath("sessionData", path.join(userDataPath, "chromium"));

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("Another instance of RPA Client is already running. Exiting.");
  app.quit();
  process.exit(0);
}

initializeMainLogging(userDataPath);

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let trayManager: TrayManager | null = null;

const store = new ClientStore(userDataPath);
const credentials = new ClientCredentialStore(userDataPath);
const deviceManager = new DeviceManager(userDataPath);
const connection = new ClientConnection(store, credentials, deviceManager);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: "RPA Execution Client V2",
    backgroundColor: "#0d131f",
    webPreferences: {
      preload: path.join(root, "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Close button minimizes to tray
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
      logClientEvent("Window minimized to tray");
    }
  });

  const rendererHtml = path.join(root, "renderer", "index.html");
  void win.loadFile(rendererHtml);

  return win;
}

// Single-instance second instance handler
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // On Windows, keep running in background tray unless isQuitting is true
  if (isQuitting) {
    app.quit();
  }
});

async function bootstrap() {
  logClientEvent("RPA Client starting", { version: "0.1.0", userDataPath });

  await store.load();
  await credentials.hydrate();
  await deviceManager.initialize();

  mainWindow = createWindow();

  trayManager = new TrayManager(
    () => mainWindow,
    connection,
    () => {
      isQuitting = true;
      trayManager?.destroy();
      app.quit();
    }
  );
  trayManager.initialize();

  // Forward state updates to renderer
  connection.onStateChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("client:state-change", state);
    }
  });

  // Forward log updates to renderer
  setLogListener((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("client:log", entry);
    }
  });

  // IPC command handler
  ipcMain.handle("client:command", async (_event, cmd: ClientCommand) => {
    switch (cmd.type) {
      case "getConnectionState":
        return connection.getState();
      case "setEndpoint":
        return await connection.setEndpoint(cmd.endpoint);
      case "connect":
        return await connection.connect(cmd.apiKey, cmd.endpoint);
      case "disconnect":
        return await connection.disconnect();
      case "setDisplayName": {
        await deviceManager.setDisplayName(cmd.displayName);
        return connection.getState();
      }
      case "triggerHeartbeat":
        return await connection.triggerHeartbeatNow();
      default:
        throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`);
    }
  });

  // Auto-reconnect if saved credential exists
  if (credentials.hasKey()) {
    logClientEvent("Found saved credentials, initiating auto-reconnect");
    void connection.reconnectSaved();
  }
}

app.whenReady().then(bootstrap).catch((err) => {
  logClientError("Bootstrap fatal error", err);
  process.exit(1);
});
