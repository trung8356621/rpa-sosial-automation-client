/**
 * Browser module structure placeholder for Epic 4+.
 * In Phase 1-3 (M2), no browser instances, profiles, or automation runs.
 */
export interface BrowserMetadataSnapshot {
  runtimeStatus: "idle" | "ready" | "busy" | "error";
  runningProfilesCount: number;
  activeAccountsCount: number;
}

export class BrowserPlaceholderManager {
  getStatus(): BrowserMetadataSnapshot {
    return {
      runtimeStatus: "idle",
      runningProfilesCount: 0,
      activeAccountsCount: 0,
    };
  }
}
