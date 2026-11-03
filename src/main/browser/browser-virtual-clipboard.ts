/**
 * In-memory clipboard isolated per RPA Browser Profile id.
 * Never touches the OS / Electron clipboard module.
 */
export class BrowserVirtualClipboard {
  private readonly byBrowserId = new Map<string, string>();

  write(browserId: string, text: string): void {
    if (!browserId) return;
    // Bound memory — reject absurd payloads without logging content.
    if (text.length > 2_000_000) {
      this.byBrowserId.set(browserId, text.slice(0, 2_000_000));
      return;
    }
    this.byBrowserId.set(browserId, text);
  }

  read(browserId: string): string {
    if (!browserId) return "";
    return this.byBrowserId.get(browserId) ?? "";
  }

  clear(browserId: string): void {
    this.byBrowserId.delete(browserId);
  }

  clearAll(): void {
    this.byBrowserId.clear();
  }

  has(browserId: string): boolean {
    return this.byBrowserId.has(browserId);
  }
}

export const sharedBrowserVirtualClipboard = new BrowserVirtualClipboard();
