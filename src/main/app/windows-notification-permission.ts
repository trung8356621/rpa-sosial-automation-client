import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shell } from "electron";
import {
  APP_USER_MODEL_ID,
  mapToastSettingToStatus,
  unverifiedBlockedStatus,
  type WindowsNotificationStatus,
} from "../../shared/windows-notification.js";
import { logClientError, logClientEvent } from "../main-error-log.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 8_000;

function buildQueryCommand(appUserModelId: string): string {
  // ToastNotifier.Setting via official WinRT; emit integer only.
  const escapedId = appUserModelId.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue | Out-Null",
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    `$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escapedId}')`,
    "if ($null -eq $n) { throw 'ToastNotifier was null' }",
    "Write-Output ([int]$n.Setting)",
  ].join("; ");
}

function parseSettingOutput(stdout: string): number {
  const line = stdout
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) {
    throw new Error("Empty ToastNotifier.Setting output");
  }
  const value = Number.parseInt(line, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Unexpected ToastNotifier.Setting output: ${line}`);
  }
  return value;
}

/**
 * Reads Windows.UI.Notifications.ToastNotifier.Setting for this app's AUMID.
 * Conservative: any failure → Blocked + "Không xác minh được quyền" (never Allowed).
 */
export async function getWindowsNotificationStatus(
  appUserModelId: string = APP_USER_MODEL_ID,
): Promise<WindowsNotificationStatus> {
  if (process.platform !== "win32") {
    return unverifiedBlockedStatus(appUserModelId);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildQueryCommand(appUserModelId),
      ],
      {
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );

    if (stderr && /throw|error|exception/i.test(stderr) && !stdout.trim()) {
      throw new Error(stderr.trim());
    }

    const settingValue = parseSettingOutput(stdout);
    const status = mapToastSettingToStatus(settingValue, appUserModelId);
    logClientEvent("Windows notification permission checked", {
      status: status.status,
      setting: status.setting,
      verified: status.verified,
      appUserModelId,
    });
    return status;
  } catch (err) {
    logClientError("Failed to verify Windows ToastNotifier.Setting", err);
    return unverifiedBlockedStatus(appUserModelId);
  }
}

/** Opens Settings → System → Notifications. Does not mutate registry or permissions. */
export async function openWindowsNotificationSettings(): Promise<void> {
  await shell.openExternal("ms-settings:notifications");
}
