import { app, BrowserWindow, WebContentsView } from "electron";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = root;
const artifactsDir = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\14aac746-126d-42f6-8319-634670695e24";

// Ensure app uses actual .local/client directory
const userDataPath = path.join(project, ".local", "client");
app.setPath("userData", userDataPath);
app.setPath("sessionData", path.join(userDataPath, "chromium"));

async function captureDeliverables() {
  console.log("=== CAPTURING M3 DELIVERABLES ===");

  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    title: "RPA Execution Client V2 - Browser Profiles",
    backgroundColor: "#0b111e",
    show: true,
    webPreferences: {
      preload: path.join(root, "dist", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const rendererHtml = path.join(root, "dist", "renderer", "index.html");
  await win.loadFile(rendererHtml);

  // Wait for renderer hydration
  await new Promise((r) => setTimeout(r, 2000));

  // 1. Create two profiles via client command if not already present
  console.log("Creating profiles...");
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        const state = await window.client.invoke({ type: "getBrowserState" });
        if (state.profiles.length < 2) {
          await window.client.invoke({ type: "createBrowserProfile", name: "Facebook Marketing 01", platform: "facebook" });
          await window.client.invoke({ type: "createBrowserProfile", name: "Facebook Group Seeding", platform: "facebook" });
        }
      })()
    `);
  } catch (err) {
    console.error("Error setting up profiles:", err);
  }

  await new Promise((r) => setTimeout(r, 1000));

  // Screenshot 1: client-browser-profiles.png (stopped state with 2 profiles)
  const img1 = await win.webContents.capturePage();
  const path1 = path.join(artifactsDir, "client-browser-profiles.png");
  await writeFile(path1, img1.toPNG());
  console.log("Saved screenshot 1 to:", path1);

  // 2. Open first profile and navigate
  console.log("Opening profile 1...");
  await win.webContents.executeJavaScript(`
    (async () => {
      const state = await window.client.invoke({ type: "getBrowserState" });
      const p1 = state.profiles[0];
      if (p1) {
        await window.client.invoke({ type: "openBrowser", browserId: p1.browserId, initialUrl: "https://example.com" });
      }
    })()
  `);

  // Wait for page to load & WebContentsView to render
  await new Promise((r) => setTimeout(r, 3500));

  // Screenshot 2: client-browser-running.png
  const img2 = await win.webContents.capturePage();
  const path2 = path.join(artifactsDir, "client-browser-running.png");
  await writeFile(path2, img2.toPNG());
  console.log("Saved screenshot 2 to:", path2);

  // 3. Now capture SEO-OPS Browser Sessions UI
  console.log("Capturing SEO-OPS Sessions UI...");
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

  // Ignore certificate errors for .test domain
  seoWin.webContents.session.setCertificateVerifyProc((_request, callback) => {
    callback(0); // accept
  });

  try {
    await seoWin.loadURL("https://seo-ops.test/admin/social-automation/sessions");
    // Wait for Filament page render
    await new Promise((r) => setTimeout(r, 2500));
    const img3 = await seoWin.webContents.capturePage();
    const path3 = path.join(artifactsDir, "seo-ops-browser-sessions.png");
    await writeFile(path3, img3.toPNG());
    console.log("Saved screenshot 3 to:", path3);
  } catch (err) {
    console.error("Failed loading SEO-OPS UI directly, checking fallback:", err);
  }

  console.log("=== ALL SCREENSHOTS CAPTURED ===");
  seoWin.destroy();
  win.destroy();
  app.quit();
}

app.whenReady().then(captureDeliverables).catch((e) => {
  console.error(e);
  process.exit(1);
});
