import { app, BrowserWindow, WebContentsView } from "electron";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpUserData = path.join(root, ".local", "poc-temp");
app.setPath("userData", tmpUserData);

async function runPoc() {
  console.log("=== STARTING BACKGROUND BROWSER POC ===");

  const results = {
    unfocused: { screenshot: "UNKNOWN", click: "UNKNOWN", typing: "UNKNOWN" },
    hidden: { screenshot: "UNKNOWN", click: "UNKNOWN", typing: "UNKNOWN" },
    imageChecks: {},
  };

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  view.setVisible(true);

  const wc = view.webContents;

  const testHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>POC Background Test</title>
        <style>
          body { font-family: sans-serif; background: #ffffff; color: #000; padding: 20px; margin: 0; }
          #btn { display: inline-block; padding: 14px 28px; font-size: 18px; background: #2563eb; color: #fff; border: 2px solid #1d4ed8; cursor: pointer; }
          #txt { padding: 8px 12px; font-size: 16px; width: 300px; margin-top: 16px; display: block; border: 2px solid #64748b; }
          #counter { font-size: 24px; font-weight: bold; margin-top: 12px; color: #16a34a; }
        </style>
      </head>
      <body>
        <h2 style="margin-top:0">Background Automation Test</h2>
        <button id="btn" onclick="inc()">Click Me</button>
        <div id="counter">0</div>
        <input id="txt" type="text" placeholder="Type here..." />
        <script>
          let count = 0;
          function inc() {
            count++;
            document.getElementById('counter').innerText = String(count);
          }
        </script>
      </body>
    </html>
  `;

  await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`);

  try {
    wc.debugger.attach("1.3");
  } catch (err) {
    console.error("Failed to attach debugger:", err);
  }

  await wc.debugger.sendCommand("Page.enable");
  await wc.debugger.sendCommand("DOM.enable");
  await wc.debugger.sendCommand("Runtime.enable");

  // Get exact coordinates of the button
  const rect = await wc.executeJavaScript(`
    (() => {
      const b = document.getElementById('btn').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()
  `);
  console.log("Button center coordinates:", rect);

  // Blur window
  win.blur();

  // Test 1: Unfocused CDP Screenshot
  try {
    const screenshotData = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(screenshotData.data, "base64");
    if (buffer.length > 500) {
      results.unfocused.screenshot = "PASS";
      results.imageChecks.unfocusedSize = buffer.length;
      await mkdir(path.join(root, "screenshots"), { recursive: true });
      await writeFile(path.join(root, "screenshots", "poc-unfocused.png"), buffer);
    } else {
      results.unfocused.screenshot = "FAIL: Empty buffer";
    }
  } catch (err) {
    results.unfocused.screenshot = `FAIL: ${err.message}`;
  }

  // Test 1: Unfocused CDP Click
  try {
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });

    const count = await wc.executeJavaScript("document.getElementById('counter').innerText");
    results.unfocused.click = count === "1" ? "PASS (counter=1)" : `FAIL: counter is ${count}`;
  } catch (err) {
    results.unfocused.click = `FAIL: ${err.message}`;
  }

  // Test 1: Unfocused CDP Typing
  try {
    await wc.executeJavaScript("document.getElementById('txt').focus()");
    for (const char of "RPA_BACKGROUND_OK") {
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char,
      });
    }
    const val = await wc.executeJavaScript("document.getElementById('txt').value");
    results.unfocused.typing = val === "RPA_BACKGROUND_OK" ? "PASS" : `FAIL: val='${val}'`;
  } catch (err) {
    results.unfocused.typing = `FAIL: ${err.message}`;
  }

  // TEST 2: Hidden / Minimized window
  win.hide();
  view.setVisible(false);

  // Hidden CDP Click
  try {
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });

    const count2 = await wc.executeJavaScript("document.getElementById('counter').innerText");
    results.hidden.click = count2 === "2" ? "PASS (counter=2 while hidden)" : `FAIL: counter is ${count2}`;
  } catch (err) {
    results.hidden.click = `FAIL: ${err.message}`;
  }

  // Hidden CDP Typing
  try {
    await wc.executeJavaScript("document.getElementById('txt').focus()");
    for (const char of "_HIDDEN") {
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char,
      });
    }
    const val2 = await wc.executeJavaScript("document.getElementById('txt').value");
    results.hidden.typing = val2 === "RPA_BACKGROUND_OK_HIDDEN" ? "PASS" : `FAIL: val='${val2}'`;
  } catch (err) {
    results.hidden.typing = `FAIL: ${err.message}`;
  }

  // Hidden CDP Screenshot
  try {
    const screenshotData2 = await wc.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
    });
    const buffer2 = Buffer.from(screenshotData2.data, "base64");
    if (buffer2.length > 500) {
      results.hidden.screenshot = "PASS";
      results.imageChecks.hiddenSize = buffer2.length;
      await writeFile(path.join(root, "screenshots", "poc-hidden.png"), buffer2);
    } else {
      results.hidden.screenshot = "FAIL: Empty image";
    }
  } catch (err) {
    results.hidden.screenshot = `PARTIAL: ${err.message}`;
  }

  console.log("=== POC EXECUTION RESULTS ===");
  console.log(JSON.stringify(results, null, 2));

  try {
    wc.debugger.detach();
  } catch {}
  win.destroy();
  app.quit();
}

app.whenReady().then(runPoc);
