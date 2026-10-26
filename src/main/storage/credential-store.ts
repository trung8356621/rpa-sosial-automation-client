import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

interface SafeStorageApi {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

let cachedSafeStorage: SafeStorageApi | null | undefined = undefined;

async function getSafeStorage(): Promise<SafeStorageApi | null> {
  if (cachedSafeStorage !== undefined) {
    return cachedSafeStorage;
  }
  try {
    const electron = await import("electron");
    if (electron && "safeStorage" in electron && typeof electron.safeStorage?.isEncryptionAvailable === "function") {
      cachedSafeStorage = electron.safeStorage;
      return cachedSafeStorage;
    }
  } catch {
    // Outside electron
  }
  cachedSafeStorage = null;
  return null;
}

export class ClientCredentialStore {
  private filePath: string;
  private inMemoryKey: string | null = null;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "client-api.token");
  }

  getKey(): string | null {
    return this.inMemoryKey;
  }

  hasKey(): boolean {
    return Boolean(this.inMemoryKey && this.inMemoryKey.trim().length > 0);
  }

  getKeyPrefix(): string | undefined {
    if (!this.inMemoryKey) return undefined;
    const parts = this.inMemoryKey.split("_");
    if (parts.length >= 3) {
      return `${parts[0]}_${parts[1]}_${parts[2].slice(0, 8)}`;
    }
    return this.inMemoryKey.slice(0, 16);
  }

  async setKey(key: string | null): Promise<void> {
    this.inMemoryKey = key ? key.trim() : null;
    await this.persist(this.inMemoryKey);
  }

  async clearKey(): Promise<void> {
    this.inMemoryKey = null;
    await unlink(this.filePath).catch(() => undefined);
  }

  async hydrate(): Promise<string | null> {
    const safeStorage = await getSafeStorage();
    try {
      const raw = await readFile(this.filePath);
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        this.inMemoryKey = null;
        return null;
      }
      this.inMemoryKey = safeStorage.decryptString(raw);
      return this.inMemoryKey;
    } catch {
      this.inMemoryKey = null;
      return null;
    }
  }

  private async persist(key: string | null): Promise<void> {
    try {
      if (!key) {
        await unlink(this.filePath).catch(() => undefined);
        return;
      }
      const safeStorage = await getSafeStorage();
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        // Refuse plaintext disk persistence
        return;
      }
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const buf = safeStorage.encryptString(key);
      await writeFile(this.filePath, buf);
    } catch {
      // In-memory key remains available for current session
    }
  }
}
