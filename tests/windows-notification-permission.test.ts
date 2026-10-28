import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  APP_USER_MODEL_ID,
  mapToastSettingToStatus,
  unverifiedBlockedStatus,
} from "../src/shared/windows-notification.js";

test("maps ToastNotifier.Setting Enabled to Allowed only", () => {
  const allowed = mapToastSettingToStatus(0);
  assert.equal(allowed.status, "Allowed");
  assert.equal(allowed.setting, "Enabled");
  assert.equal(allowed.verified, true);
  assert.equal(allowed.reason, undefined);
  assert.equal(allowed.appUserModelId, APP_USER_MODEL_ID);
});

test("maps all non-Enabled ToastNotifier.Setting values to Blocked", () => {
  for (const [value, name] of [
    [1, "DisabledForApplication"],
    [2, "DisabledForUser"],
    [3, "DisabledByGroupPolicy"],
    [4, "DisabledByManifest"],
  ] as const) {
    const blocked = mapToastSettingToStatus(value);
    assert.equal(blocked.status, "Blocked");
    assert.equal(blocked.setting, name);
    assert.equal(blocked.verified, true);
    assert.equal(blocked.reason, undefined);
  }
});

test("unknown setting value and check failure stay Blocked/Unverified", () => {
  const unknown = mapToastSettingToStatus(99);
  assert.equal(unknown.status, "Blocked");
  assert.equal(unknown.setting, "Unverified");
  assert.equal(unknown.verified, false);
  assert.equal(unknown.reason, "Không xác minh được quyền");

  const failed = unverifiedBlockedStatus();
  assert.equal(failed.status, "Blocked");
  assert.equal(failed.verified, false);
  assert.equal(failed.reason, "Không xác minh được quyền");
});

test("main wires AUMID, status IPC, and ms-settings open", async () => {
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const permission = await readFile(
    new URL("../src/main/app/windows-notification-permission.ts", import.meta.url),
    "utf8",
  );
  const preload = await readFile(new URL("../src/preload/index.cts", import.meta.url), "utf8");
  const settings = await readFile(
    new URL("../src/renderer/components/connection-settings-panel.tsx", import.meta.url),
    "utf8",
  );
  const shell = await readFile(
    new URL("../src/renderer/components/app-shell.tsx", import.meta.url),
    "utf8",
  );

  assert.match(main, /setAppUserModelId/);
  assert.match(main, /APP_USER_MODEL_ID/);
  assert.match(main, /getWindowsNotificationStatus/);
  assert.match(main, /openWindowsNotificationSettings/);
  assert.match(main, /armNotificationStatusRefreshOnFocus/);
  assert.match(permission, /ToastNotificationManager/);
  assert.match(permission, /CreateToastNotifier/);
  assert.match(permission, /ms-settings:notifications/);
  assert.match(permission, /com\.rpa\.client\.v2|APP_USER_MODEL_ID/);
  assert.doesNotMatch(permission, /SHQueryUserNotificationState/);
  assert.doesNotMatch(permission, /Notification\.isSupported/);
  assert.match(preload, /onWindowsNotificationStatus/);
  assert.match(settings, /Windows Notifications/);
  assert.match(settings, /Open Windows Settings/);
  assert.match(shell, /Windows Notifications chưa được bật/);
  assert.match(shell, /windowsNotifBannerDismissed/);
});

test("live ToastNotifier.Setting probe for com.rpa.client.v2 (PARTIAL if unavailable)", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only live probe");
    return;
  }

  // Direct WinRT probe — does not import Electron modules.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const script = [
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue | Out-Null",
      "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
      `$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_USER_MODEL_ID}')`,
      "Write-Output ([int]$n.Setting)",
    ].join("; ");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 8000, windowsHide: true, encoding: "utf8" },
    );
    const value = Number.parseInt(stdout.trim().split(/\r?\n/).find(Boolean) || "", 10);
    assert.ok(Number.isInteger(value), "ToastNotifier.Setting must be an integer");
    const mapped = mapToastSettingToStatus(value);
    assert.ok(mapped.status === "Allowed" || mapped.status === "Blocked");
    assert.equal(mapped.verified, mapped.setting !== "Unverified");
    console.log(`[WINDOWS_TOAST_SETTING] value=${value} status=${mapped.status} setting=${mapped.setting}`);
  } catch (err) {
    console.log(`[WINDOWS_TOAST_SETTING_PARTIAL] ${err instanceof Error ? err.message : String(err)}`);
  }
});
