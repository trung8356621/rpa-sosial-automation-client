import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ALLOWED_DEV_INSTANCES = ["client-A", "client-B", "client-C"] as const;
export type DevInstanceId = string;
const DEV_INSTANCE_PATTERN = /^client-[A-Za-z0-9_-]{1,32}$/;

export function isAllowedDevInstance(value: string | undefined | null): value is DevInstanceId {
  return Boolean(value && DEV_INSTANCE_PATTERN.test(value));
}

export interface DevInstanceConfig {
  instanceId?: string;
  socketEnabled?: boolean;
  claimEnabled?: boolean;
}

export function readDevInstanceConfig(userDataPath: string): DevInstanceConfig | null {
  try {
    const raw = readFileSync(path.join(userDataPath, "instance.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as DevInstanceConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve dev-only instance id from CLI (--instance=client-A) or env (RPA_DEV_INSTANCE).
 * Returns null when running in single-instance default/production mode.
 */
export function parseDevInstanceId(argv: readonly string[], env: NodeJS.ProcessEnv): DevInstanceId | null {
  const arg = argv.find((a) => a.startsWith("--instance="));
  const raw = (arg ? arg.slice("--instance=".length) : env.RPA_DEV_INSTANCE)?.trim();
  if (!raw) return null;
  if (!isAllowedDevInstance(raw)) {
    throw new Error(
      `Invalid dev instance "${raw}". Expected format: client-<id> (e.g. client-A, client-D)`
    );
  }
  return raw;
}

/**
 * Resolve isolated userData directory for a dev instance, or default .local/client when unset.
 */
export function resolveDevUserDataPath(
  projectRoot: string,
  instanceId: DevInstanceId | null
): string {
  if (!instanceId) {
    return path.join(projectRoot, ".local", "client");
  }
  return path.join(projectRoot, ".local", "instances", instanceId);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means process exists but belongs to another user/elevation
    return code === "EPERM";
  }
}

export interface InstanceLockHandle {
  lockPath: string;
  release: () => void;
}

/**
 * Prevent accidental simultaneous use of the same userData directory via an exclusive PID lockfile.
 */
export function acquireInstanceLock(
  userDataPath: string,
  pid: number = process.pid
): InstanceLockHandle {
  mkdirSync(userDataPath, { recursive: true });
  const lockPath = path.join(userDataPath, "instance.lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      let released = false;
      return {
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
            if (current.pid === pid) unlinkSync(lockPath);
          } catch {
            // ignore cleanup errors on exit
          }
        },
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      let existingPid: number | null = null;
      try {
        const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
        if (typeof parsed.pid === "number") existingPid = parsed.pid;
      } catch {
        // corrupt/stale lockfile
      }
      if (existingPid != null && isPidAlive(existingPid)) {
        throw new Error(
          `userData directory "${userDataPath}" is already in use by PID ${existingPid}`
        );
      }
      // Stale lockfile from crashed process — remove and retry once
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }

  throw new Error(`Failed to acquire instance lock at ${lockPath}`);
}
