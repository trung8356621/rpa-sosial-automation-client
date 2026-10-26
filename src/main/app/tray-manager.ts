import { app, Tray, Menu, nativeImage, BrowserWindow } from "electron";
import path from "node:path";
import type { ClientConnection } from "../connection/client-connection.js";

export class TrayManager {
  private tray: Tray | null = null;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly connection: ClientConnection,
    private readonly onQuit: () => void
  ) {}

  initialize(): void {
    if (this.tray) return;

    // Create a 16x16 icon in memory (transparent PNG with colored dot or simple icon)
    const icon = nativeImage.createFromBuffer(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA0SURBVDhPY/wPBAwUACYoTSRgVAMGBkKuo2FA5n8GBgYk9yMLkqsB2fxB00AYDYORakAwBwAA95sRz6v0n8kAAAAASUVORK5CYII=",
        "base64"
      )
    );

    this.tray = new Tray(icon);
    this.tray.setToolTip("RPA Client V2");

    this.tray.on("click", () => {
      const win = this.getMainWindow();
      if (!win) return;
      if (win.isVisible()) {
        if (win.isFocused()) {
          win.hide();
        } else {
          win.focus();
        }
      } else {
        win.show();
        win.focus();
      }
    });

    this.updateMenu();
    this.connection.onStateChange(() => this.updateMenu());
  }

  updateMenu(): void {
    if (!this.tray) return;
    const state = this.connection.getState();
    const statusText = state.status === "connected" && state.online
      ? `Online (${state.device?.displayName || "Device"})`
      : state.status === "connecting"
        ? "Đang kết nối..."
        : "Offline / Disconnected";

    this.tray.setToolTip(`RPA Client V2 — ${statusText}`);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `Trạng thái: ${statusText}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Mở ứng dụng",
        click: () => {
          const win = this.getMainWindow();
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      {
        label: "Gửi Heartbeat ngay",
        enabled: state.status === "connected",
        click: () => {
          void this.connection.triggerHeartbeatNow();
        },
      },
      {
        label: "Kết nối lại",
        click: () => {
          void this.connection.reconnectSaved();
        },
      },
      { type: "separator" },
      {
        label: "Thoát hoàn toàn (Quit)",
        click: () => {
          this.onQuit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
