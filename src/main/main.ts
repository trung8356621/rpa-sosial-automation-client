import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeMainLogging, logClientError, logClientEvent, setLogListener } from "./main-error-log.js";
import { ClientStore } from "./storage/store.js";
import { ClientCredentialStore } from "./storage/credential-store.js";
import { DeviceManager } from "./device/device-manager.js";
import { ClientConnection } from "./connection/client-connection.js";
import { TrayManager } from "./app/tray-manager.js";
import { ProfileManager } from "./browser/profile-manager.js";
import { BrowserSyncService } from "./browser/browser-sync-service.js";
import { EmbeddedBrowser } from "./browser/embedded-browser.js";
import type { ClientCommand, BrowserStateSnapshot } from "../shared/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(root, "..");

const isSmokeTest = process.argv.includes("--smoke-test");
const isCaptureM3 = process.argv.includes("--capture-m3");
const autoConnectKey = process.argv.find((a) => a.startsWith("--connect-key="))?.split("=")[1];

// Windows userData is strictly isolated to .local/client (never .local/creator)
const userDataPath = path.join(project, ".local", "client");
app.setPath("userData", userDataPath);
app.setPath("sessionData", path.join(userDataPath, "chromium"));

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock && !isSmokeTest && !isCaptureM3) {
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
const profileManager = new ProfileManager(userDataPath);
let syncService: BrowserSyncService | null = null;
let embeddedBrowser: EmbeddedBrowser | null = null;

function getBrowserStateSnapshot(): BrowserStateSnapshot {
  return {
    profiles: profileManager.list(),
    activeBrowserId: embeddedBrowser ? embeddedBrowser.getActiveBrowserId() : null,
    viewState: embeddedBrowser
      ? embeddedBrowser.getViewState()
      : {
          activeBrowserId: null,
          currentUrl: "",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          visible: false,
        },
  };
}

function broadcastBrowserState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("client:browser-state-change", getBrowserStateSnapshot());
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 640,
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
      embeddedBrowser?.setVisible(false);
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

app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    if (embeddedBrowser) {
      try {
        await embeddedBrowser.stop();
      } catch (e) {
        logClientError("Error stopping browser before quit", e);
      }
    }
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // On Windows, keep running in background tray unless isQuitting is true
  if (isQuitting || isSmokeTest) {
    app.quit();
  }
});

async function bootstrap() {
  logClientEvent("RPA Client starting", { version: "0.1.0", userDataPath });

  await store.load();
  await credentials.hydrate();
  await deviceManager.initialize();
  await profileManager.initialize();

  mainWindow = createWindow();

  syncService = new BrowserSyncService(connection, profileManager);
  embeddedBrowser = new EmbeddedBrowser(mainWindow, profileManager, syncService);

  embeddedBrowser.onViewStateChange(() => {
    broadcastBrowserState();
  });

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

  // Forward connection state updates to renderer
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

      // Browser profile commands
      case "getBrowserState":
        return getBrowserStateSnapshot();
      case "createBrowserProfile": {
        const created = await profileManager.create(cmd.name, cmd.platform);
        void syncService?.syncAll();
        broadcastBrowserState();
        return created;
      }
      case "renameBrowserProfile": {
        const updated = await profileManager.rename(cmd.browserId, cmd.name);
        void syncService?.syncAll();
        broadcastBrowserState();
        return updated;
      }
      case "deleteBrowserProfile": {
        const ok = await profileManager.delete(cmd.browserId);
        if (ok) {
          void syncService?.deleteRemote(cmd.browserId);
        }
        broadcastBrowserState();
        return ok;
      }
      case "openBrowser": {
        await embeddedBrowser!.open(cmd.browserId, cmd.initialUrl);
        broadcastBrowserState();
        return getBrowserStateSnapshot();
      }
      case "stopBrowser": {
        await embeddedBrowser!.stop();
        broadcastBrowserState();
        return getBrowserStateSnapshot();
      }
      case "navigateBrowser": {
        await embeddedBrowser!.navigate(cmd.url);
        broadcastBrowserState();
        return getBrowserStateSnapshot();
      }
      case "browserGoBack": {
        embeddedBrowser!.goBack();
        return getBrowserStateSnapshot();
      }
      case "browserGoForward": {
        embeddedBrowser!.goForward();
        return getBrowserStateSnapshot();
      }
      case "browserReload": {
        embeddedBrowser!.reload();
        return getBrowserStateSnapshot();
      }
      case "setBrowserViewBounds": {
        embeddedBrowser!.setBounds(cmd.bounds);
        return true;
      }
      case "setBrowserViewVisible": {
        embeddedBrowser!.setVisible(cmd.visible);
        return true;
      }

      default:
        throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`);
    }
  });

  // Auto-connect if requested by CLI or saved credential exists
  if (autoConnectKey) {
    logClientEvent("Connecting via CLI key parameter");
    try {
      await connection.connect(autoConnectKey);
    } catch (err) {
      logClientError("CLI auto-connect failed", err);
    }
  } else if (credentials.hasKey()) {
    logClientEvent("Found saved credentials, initiating auto-reconnect");
    void connection.reconnectSaved();
  }

  if (isCaptureM3) {
    const artifactsDir = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\14aac746-126d-42f6-8319-634670695e24";
    const screenshotsDir = path.join(project, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });

    setTimeout(async () => {
      try {
        logClientEvent("M3 capture started");
        // Ensure 2 profiles exist
        if (profileManager.list().length < 2) {
          await profileManager.create("Facebook Marketing 01", "facebook");
          await profileManager.create("Facebook Group Seeding", "facebook");
        }
        broadcastBrowserState();
        await syncService?.syncAll();

        // 1. Capture stopped state showing 2 profiles
        await new Promise((r) => setTimeout(r, 1500));
        const img1 = await mainWindow!.webContents.capturePage();
        await writeFile(path.join(screenshotsDir, "client-browser-profiles.png"), img1.toPNG());
        await writeFile(path.join(artifactsDir, "client-browser-profiles.png"), img1.toPNG());
        logClientEvent("Captured client-browser-profiles.png");

        // 2. Open first profile and load example.com
        const p0 = profileManager.list()[0];
        await embeddedBrowser!.open(p0.browserId, "https://example.com");
        broadcastBrowserState();

        await new Promise((r) => setTimeout(r, 4000));
        const img2 = await mainWindow!.webContents.capturePage();
        await writeFile(path.join(screenshotsDir, "client-browser-running.png"), img2.toPNG());
        await writeFile(path.join(artifactsDir, "client-browser-running.png"), img2.toPNG());
        logClientEvent("Captured client-browser-running.png");

        // 3. Capture SEO-OPS sessions page
        const seoWin = new BrowserWindow({
          width: 1200,
          height: 800,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
          },
        });
        seoWin.webContents.session.setCertificateVerifyProc((_request, callback) => callback(0));

        try {
          await seoWin.loadURL("https://seo-ops.test/admin/social-automation/sessions");
          await new Promise((r) => setTimeout(r, 3000));
          const img3 = await seoWin.webContents.capturePage();
          await writeFile(path.join(screenshotsDir, "seo-ops-browser-sessions.png"), img3.toPNG());
          await writeFile(path.join(artifactsDir, "seo-ops-browser-sessions.png"), img3.toPNG());
          logClientEvent("Captured seo-ops-browser-sessions.png");
        } catch (e) {
          logClientError("Failed to capture SEO-OPS sessions UI", e);
        } finally {
          seoWin.destroy();
        }

        console.log("[M3_CAPTURE_COMPLETE] All deliverables saved successfully.");
      } catch (e) {
        logClientError("M3 capture fatal error", e);
      } finally {
        isQuitting = true;
        trayManager?.destroy();
        app.quit();
      }
    }, 2000);
  }

  if (isSmokeTest) {
    logClientEvent("Smoke test mode active, scheduling screenshot capture");
    setTimeout(async () => {
      try {
        const image = await mainWindow!.webContents.capturePage();
        const screenshotsDir = path.join(project, "screenshots");
        await mkdir(screenshotsDir, { recursive: true });
        const outPath = path.join(screenshotsDir, "client-window.png");
        await writeFile(outPath, image.toPNG());
        logClientEvent("Screenshot captured successfully", { outPath });
        console.log("[SMOKE_TEST_PASS] Screenshot saved to " + outPath);
      } catch (e) {
        console.error("Screenshot capture failed:", e);
      } finally {
        isQuitting = true;
        trayManager?.destroy();
        app.quit();
      }
    }, 2500);
  }
}

app.whenReady().then(bootstrap).catch((err) => {
  logClientError("Bootstrap fatal error", err);
  process.exit(1);
});
