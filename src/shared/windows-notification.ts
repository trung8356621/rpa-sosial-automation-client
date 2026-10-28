/** Stable AUMID used for Windows Toast association (must match main process). */
export const APP_USER_MODEL_ID = "com.rpa.client.v2";

/** Official Windows.UI.Notifications.ToastNotificationSetting values. */
export const ToastNotificationSetting = {
  Enabled: 0,
  DisabledForApplication: 1,
  DisabledForUser: 2,
  DisabledByGroupPolicy: 3,
  DisabledByManifest: 4,
} as const;

export type ToastNotificationSettingName =
  | "Enabled"
  | "DisabledForApplication"
  | "DisabledForUser"
  | "DisabledByGroupPolicy"
  | "DisabledByManifest";

export type WindowsNotificationDisplayStatus = "Allowed" | "Blocked";

export interface WindowsNotificationStatus {
  status: WindowsNotificationDisplayStatus;
  /** Raw ToastNotifier.Setting name when verified; Unverified on check failure. */
  setting: ToastNotificationSettingName | "Unverified";
  verified: boolean;
  /** Present when Blocked due to check failure (not conflated with user-disabled). */
  reason?: string;
  appUserModelId: string;
}

const SETTING_BY_VALUE: Record<number, ToastNotificationSettingName> = {
  [ToastNotificationSetting.Enabled]: "Enabled",
  [ToastNotificationSetting.DisabledForApplication]: "DisabledForApplication",
  [ToastNotificationSetting.DisabledForUser]: "DisabledForUser",
  [ToastNotificationSetting.DisabledByGroupPolicy]: "DisabledByGroupPolicy",
  [ToastNotificationSetting.DisabledByManifest]: "DisabledByManifest",
};

export function mapToastSettingToStatus(
  settingValue: number,
  appUserModelId: string = APP_USER_MODEL_ID,
): WindowsNotificationStatus {
  const setting = SETTING_BY_VALUE[settingValue];
  if (!setting) {
    return {
      status: "Blocked",
      setting: "Unverified",
      verified: false,
      reason: "Không xác minh được quyền",
      appUserModelId,
    };
  }
  if (setting === "Enabled") {
    return {
      status: "Allowed",
      setting,
      verified: true,
      appUserModelId,
    };
  }
  return {
    status: "Blocked",
    setting,
    verified: true,
    appUserModelId,
  };
}

export function unverifiedBlockedStatus(
  appUserModelId: string = APP_USER_MODEL_ID,
): WindowsNotificationStatus {
  return {
    status: "Blocked",
    setting: "Unverified",
    verified: false,
    reason: "Không xác minh được quyền",
    appUserModelId,
  };
}
