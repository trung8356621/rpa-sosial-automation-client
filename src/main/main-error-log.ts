import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

let logFilePath: string | null = null;
let logListener: ((entry: { time: string; level: string; message: string }) => void) | null = null;

export function initializeMainLogging(userDataPath: string) {
  logFilePath = path.join(userDataPath, "logs", "client.log");
}

export function setLogListener(listener: ((entry: { time: string; level: string; message: string }) => void) | null) {
  logListener = listener;
}

export function sanitizeLog(message: string): string {
  // Strip Bearer tokens, connection leases, passwords, and sensitive key values
  return message
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/rpa_client_[A-Za-z0-9_]+/gi, "rpa_client_[REDACTED]")
    .replace(/apiKey[:=]\s*["']?[^"'\s,]+["']?/gi, "apiKey=[REDACTED]")
    .replace(/connection_token["']?\s*[:=]\s*["']?[^"'\s,]+["']?/gi, "connection_token=[REDACTED]")
    .replace(/["']?password["']?\s*[:=]\s*["'][^"']*["']/gi, "password=[REDACTED]")
    .replace(/["']?user_pass["']?\s*[:=]\s*["'][^"']*["']/gi, "user_pass=[REDACTED]");
}

export function logClientEvent(event: string, details?: unknown) {
  const time = new Date().toISOString();
  let text = `[${time}] [INFO] ${event}`;
  if (details !== undefined) {
    text += " " + (typeof details === "string" ? details : JSON.stringify(details));
  }
  const sanitized = sanitizeLog(text);
  console.log(sanitized);

  if (logListener) {
    logListener({ time, level: "INFO", message: sanitizeLog(event + (details ? " " + JSON.stringify(details) : "")) });
  }

  if (logFilePath) {
    void (async () => {
      try {
        await mkdir(path.dirname(logFilePath!), { recursive: true });
        await appendFile(logFilePath!, sanitized + "\n", "utf8");
      } catch {
        // ignore disk log failure
      }
    })();
  }
}

export function logClientError(event: string, error: unknown) {
  const time = new Date().toISOString();
  const errMsg = error instanceof Error ? error.stack || error.message : String(error);
  const text = `[${time}] [ERROR] ${event}: ${errMsg}`;
  const sanitized = sanitizeLog(text);
  console.error(sanitized);

  if (logListener) {
    logListener({ time, level: "ERROR", message: sanitizeLog(`${event}: ${error instanceof Error ? error.message : String(error)}`) });
  }

  if (logFilePath) {
    void (async () => {
      try {
        await mkdir(path.dirname(logFilePath!), { recursive: true });
        await appendFile(logFilePath!, sanitized + "\n", "utf8");
      } catch {
        // ignore disk log failure
      }
    })();
  }
}
