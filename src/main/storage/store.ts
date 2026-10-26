import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface ClientSettings {
  endpoint: string;
  displayName?: string;
  agentUuid?: string;
  lastConnectedAt?: string;
}

export class ClientStore {
  private filePath: string;
  private settings: ClientSettings = {
    endpoint: "https://seo-ops.test",
  };
  private loaded = false;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "settings.json");
  }

  async load(): Promise<ClientSettings> {
    try {
      const data = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      this.settings = {
        endpoint: typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint.trim() : "https://seo-ops.test",
        displayName: typeof parsed.displayName === "string" ? parsed.displayName.trim() : undefined,
        agentUuid: typeof parsed.agentUuid === "string" ? parsed.agentUuid.trim() : undefined,
        lastConnectedAt: typeof parsed.lastConnectedAt === "string" ? parsed.lastConnectedAt : undefined,
      };
    } catch {
      // defaults
    }
    this.loaded = true;
    return this.settings;
  }

  get(): ClientSettings {
    return this.settings;
  }

  async set(partial: Partial<ClientSettings>): Promise<ClientSettings> {
    this.settings = { ...this.settings, ...partial };
    await this.persist();
    return this.settings;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // ignore
    }
  }
}
