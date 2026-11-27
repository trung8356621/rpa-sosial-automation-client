import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import sharp from "sharp";
import type { Capture, Rect } from "./contracts.js";

/** Map screenshot image coords → WebContents DIP input (Creator geometry semantics). */
export function imageToInput(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  bounds: Rect
): { x: number; y: number } {
  if (
    ![x, y, imageWidth, imageHeight].every(Number.isFinite) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    x >= imageWidth ||
    y >= imageHeight
  ) {
    throw new Error("Điểm ngoài ảnh.");
  }
  return {
    x: Math.floor((x * bounds.width) / imageWidth),
    y: Math.floor((y * bounds.height) / imageHeight),
  };
}

export async function normalizeCaptureBufferToDip(
  raw: Buffer,
  bounds: Rect,
  deviceScaleFactor: number
): Promise<{ buffer: Buffer; width: number; height: number; rawWidth: number; rawHeight: number }> {
  const metadata = await sharp(raw).metadata();
  const rawWidth = metadata.width ?? bounds.width;
  const rawHeight = metadata.height ?? bounds.height;
  const dpr = Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1;

  if (
    dpr > 1.01 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    (rawWidth !== bounds.width || rawHeight !== bounds.height)
  ) {
    const expectedW = Math.round(bounds.width * dpr);
    const expectedH = Math.round(bounds.height * dpr);
    if (Math.abs(rawWidth - expectedW) <= 4 && Math.abs(rawHeight - expectedH) <= 4) {
      const resized = await sharp(raw)
        .resize(bounds.width, bounds.height, { fit: "fill" })
        .png()
        .toBuffer();
      return {
        buffer: resized,
        width: bounds.width,
        height: bounds.height,
        rawWidth,
        rawHeight,
      };
    }
  }

  return { buffer: raw, width: rawWidth, height: rawHeight, rawWidth, rawHeight };
}

/**
 * Client adapter for Creator Visual ORC I/O against an embedded Browser WebContents.
 * Programmatic sendInputEvent is not blocked by the interaction-lock overlay
 * (overlay is a sibling WebContentsView; ORC targets this session's contents).
 */
export class OrcBrowserHost {
  private captures = new Map<string, Buffer>();
  private captureGate: Promise<void> = Promise.resolve();
  zoom = 1;
  deviceScaleFactor = 1;

  constructor(
    readonly webContents: WebContents,
    /** DIP bounds of the browser view (click mapping). */
    public bounds: Rect
  ) {
    try {
      this.zoom = webContents.getZoomFactor();
    } catch {
      this.zoom = 1;
    }
  }

  getSanitizedUrl(): string {
    try {
      const raw = this.webContents.getURL();
      if (!raw) return "";
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`;
    } catch {
      return "";
    }
  }

  async setZoom(zoom: number): Promise<void> {
    this.webContents.setZoomFactor(zoom);
    this.zoom = zoom;
  }

  async capture(options?: { light?: boolean }): Promise<Capture> {
    let release!: () => void;
    const prev = this.captureGate;
    this.captureGate = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.captureExclusive(options);
    } finally {
      release();
    }
  }

  private async captureExclusive(options?: { light?: boolean }): Promise<Capture> {
    const wc = this.webContents;
    if (wc.isDestroyed()) throw new Error("WebContents destroyed");
    const zoom = wc.getZoomFactor();
    this.zoom = zoom;
    let raw: Buffer;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("Page.enable").catch(() => undefined);
      const frame = await Promise.race([
        wc.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Screenshot timeout: không có frame sau 4 giây.")),
            4000
          );
        }),
      ]);
      raw = Buffer.from((frame as { data: string }).data, "base64");
    } catch (e) {
      if (wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {
          /* ignore */
        }
      }
      try {
        const image = await wc.capturePage(undefined, { stayHidden: true });
        raw = image.toPNG();
      } catch {
        throw e;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!raw.length) throw new Error("Browser trả về ảnh rỗng.");
    let dpr = 1;
    try {
      const val = await wc.executeJavaScript("window.devicePixelRatio || 1", true);
      if (typeof val === "number" && Number.isFinite(val) && val > 0) dpr = val;
    } catch {
      dpr = 1;
    }
    this.deviceScaleFactor = dpr;
    const normalized = await normalizeCaptureBufferToDip(raw, this.bounds, dpr);
    const id = randomUUID();
    this.captures.set(id, normalized.buffer);
    if (this.captures.size > 70) this.captures.delete(this.captures.keys().next().value!);
    return {
      id,
      width: normalized.width,
      height: normalized.height,
      zoom,
      url: wc.getURL(),
      timestamp: new Date().toISOString(),
      backend: "cdp-surface",
      dataUrl: options?.light ? "" : `data:image/png;base64,${normalized.buffer.toString("base64")}`,
      bounds: { ...this.bounds },
    };
  }

  captureBuffer(id: string): Buffer {
    const b = this.captures.get(id);
    if (!b) throw new Error("Ảnh đã hết hạn; chụp lại.");
    return b;
  }

  click(x: number, y: number, imageWidth: number, imageHeight: number): void {
    const p = imageToInput(x, y, imageWidth, imageHeight, this.bounds);
    this.webContents.focus();
    this.webContents.sendInputEvent({ type: "mouseMove", ...p });
    this.webContents.sendInputEvent({
      type: "mouseDown",
      ...p,
      button: "left",
      clickCount: 1,
    });
    this.webContents.sendInputEvent({
      type: "mouseUp",
      ...p,
      button: "left",
      clickCount: 1,
    });
  }

  scroll(deltaY: number): void {
    const x = Math.round(this.bounds.width / 2);
    const y = Math.round(this.bounds.height / 2);
    this.webContents.sendInputEvent({ type: "mouseMove", x, y });
    this.webContents.sendInputEvent({
      type: "mouseWheel",
      x,
      y,
      deltaY,
      deltaX: 0,
    });
  }

  /** Keyboard insert into currently focused element (Creator TYPE path lite). */
  async typeText(text: string): Promise<void> {
    if (!text || text.length > 20_000) {
      throw new Error("Nội dung cần từ 1 đến 20.000 ký tự.");
    }
    this.webContents.focus();
    for (const ch of text) {
      this.webContents.sendInputEvent({ type: "char", keyCode: ch });
    }
  }

  /** Intercept the file chooser opened by a visual click and assign local file paths via CDP. */
  async uploadFiles(files: string[], click: () => void, timeoutMs = 8000): Promise<void> {
    if (!files.length) {
      throw new Error("UPLOAD_FILE thiếu danh sách file.");
    }
    const dbg = this.webContents.debugger;
    const attachedHere = !dbg.isAttached();
    if (attachedHere) {
      dbg.attach("1.3");
    }
    let active = true;
    let handled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const chosen = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        if (!active) return;
        active = false;
        reject(new Error(message));
      };
      const onMessage = (
        _event: Electron.Event,
        method: string,
        params: { mode?: string; backendNodeId?: number },
        sessionId?: string
      ) => {
        if (!active || method !== "Page.fileChooserOpened") return;
        if (handled) {
          fail("Có thêm file chooser trong cùng lần chạy UPLOAD_FILE.");
          return;
        }
        handled = true;
        if (!Number.isInteger(params?.backendNodeId) || Number(params.backendNodeId) <= 0) {
          fail("File chooser không cung cấp backendNodeId.");
          return;
        }
        void dbg
          .sendCommand(
            "DOM.setFileInputFiles",
            { files, backendNodeId: params.backendNodeId as number },
            sessionId || undefined
          )
          .then(
            () => {
              if (!active) return;
              active = false;
              resolve();
            },
            (err) => fail(`DOM.setFileInputFiles thất bại: ${String(err)}`)
          );
      };
      dbg.on("message", onMessage);
      timer = setTimeout(
        () => fail("Không nhận được file chooser sau click UPLOAD_FILE."),
        timeoutMs
      );
      void (async () => {
        try {
          await dbg.sendCommand("Page.enable");
          await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
          click();
        } catch (err) {
          fail(`Không bật được file chooser intercept: ${String(err)}`);
        }
      })();
      void chosenCleanup;
      function chosenCleanup() {
        dbg.off("message", onMessage);
      }
    });

    try {
      await chosen;
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
      dbg.removeAllListeners("message");
      try {
        if (dbg.isAttached()) {
          await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false });
        }
      } catch {
        /* ignore */
      }
      if (attachedHere && dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
