#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INSTANCES = ["client-A", "client-B", "client-C"];
const INSTANCE_PATTERN = /^client-[A-Za-z0-9_-]{1,32}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const instancesRoot = path.join(projectRoot, ".local", "instances");

function instanceDir(id) {
  return path.join(instancesRoot, id);
}

function configPath(id) {
  return path.join(instanceDir(id), "instance.json");
}

function runnerPath(id) {
  return path.join(instanceDir(id), "runner.json");
}

function lockPath(id) {
  return path.join(instanceDir(id), "instance.lock");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function assertValidInstance(id) {
  if (!id || !INSTANCE_PATTERN.test(id)) {
    console.error(`Invalid instance "${id ?? ""}". Expected format: client-<id> (e.g. client-A, client-D)`);
    process.exit(1);
  }
}

function discoverInstances() {
  const names = new Set(DEFAULT_INSTANCES);
  if (existsSync(instancesRoot)) {
    for (const entry of readdirSync(instancesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && INSTANCE_PATTERN.test(entry.name)) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort();
}

function getDesktopDir() {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
        { encoding: "utf8" }
      ).trim();
      if (out) return out;
    } catch {
      // fallback
    }
  }
  return path.join(process.env.USERPROFILE || process.env.HOME || projectRoot, "Desktop");
}

function shortcutNameFor(id) {
  const suffix = id.replace(/^client-/i, "");
  return `RPA Client ${suffix}.lnk`;
}

function shortcutPathFor(id) {
  return path.join(getDesktopDir(), shortcutNameFor(id));
}

function resolveElectronExe() {
  if (process.platform === "win32") {
    const exe = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
    if (existsSync(exe)) return exe;
  }
  return path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
}

function createWindowsShortcut(id) {
  if (process.platform !== "win32") {
    console.log(`Shortcut creation skipped (non-Windows platform).`);
    return null;
  }
  const lnkPath = shortcutPathFor(id);
  const exe = resolveElectronExe();
  const args = `. --instance=${id}`;
  const icoPath = path.join(projectRoot, "assets", "rpa-automation-icon.ico");
  const iconLine = existsSync(icoPath)
    ? `$sc.IconLocation = '${icoPath.replace(/'/g, "''")},0'`
    : "";
  const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
$sc.TargetPath = '${exe.replace(/'/g, "''")}'
$sc.Arguments = '${args.replace(/'/g, "''")}'
$sc.WorkingDirectory = '${projectRoot.replace(/'/g, "''")}'
${iconLine}
$sc.Description = 'RPA Execution Client V2 (${id}) - Dev Multi-Instance'
$sc.Save()
`.trim();
  execFileSync("powershell.exe", ["-NoProfile", "-Command", psScript], { stdio: "pipe" });
  return lnkPath;
}

function getInstanceState(id) {
  const dir = instanceDir(id);
  const lock = readJsonSafe(lockPath(id));
  const runner = readJsonSafe(runnerPath(id));
  const cfg = readJsonSafe(configPath(id));
  const pid = isPidAlive(lock?.pid) ? lock.pid : isPidAlive(runner?.pid) ? runner.pid : null;
  const settings = readJsonSafe(path.join(dir, "settings.json"));
  const sqlitePath = path.join(dir, "keepalive", "keepalive.sqlite");
  const lnk = shortcutPathFor(id);
  return {
    instanceId: id,
    running: pid !== null,
    pid,
    userDataPath: dir,
    socketEnabled: cfg?.socketEnabled ?? runner?.socketEnabled ?? false,
    claimEnabled: cfg?.claimEnabled ?? runner?.claimEnabled ?? false,
    nodeId: settings?.keepAliveNodeId ?? null,
    sqliteExists: existsSync(sqlitePath),
    shortcutExists: existsSync(lnk),
    shortcutPath: lnk,
  };
}

function parseFlag(args, prefix) {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function parseBoolFlag(args, prefix) {
  const val = parseFlag(args, prefix);
  return val != null ? val === "1" || val === "true" : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function ensureInstanceManifest(id, socketOverride = null, claimOverride = null) {
  const dir = instanceDir(id);
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const cfgFile = configPath(id);
  const existing = readJsonSafe(cfgFile);
  if (existing) {
    // Idempotent: preserve existing profile data; only update flags if explicitly passed
    const nextSocket = socketOverride !== null ? socketOverride : Boolean(existing.socketEnabled);
    const nextClaim = claimOverride !== null ? claimOverride : Boolean(existing.claimEnabled);
    if (existing.socketEnabled !== nextSocket || existing.claimEnabled !== nextClaim) {
      const updated = { ...existing, socketEnabled: nextSocket, claimEnabled: nextClaim };
      writeFileSync(cfgFile, JSON.stringify(updated, null, 2) + "\n", "utf8");
      return { created: false, config: updated };
    }
    return { created: false, config: existing };
  }
  const createdCfg = {
    instanceId: id,
    socketEnabled: socketOverride ?? false,
    claimEnabled: claimOverride ?? false,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(cfgFile, JSON.stringify(createdCfg, null, 2) + "\n", "utf8");
  return { created: true, config: createdCfg };
}

function cmdCreate(id, args) {
  assertValidInstance(id);
  const socketOverride = parseBoolFlag(args, "--socket=");
  const claimOverride = parseBoolFlag(args, "--claim=");
  const { created, config } = ensureInstanceManifest(id, socketOverride, claimOverride);

  let lnkPath = null;
  if (hasFlag(args, "--shortcut")) {
    lnkPath = createWindowsShortcut(id);
  }
  console.log(
    `${created ? "Created" : "Preserved"} ${id} | userData=${instanceDir(id)} | socket=${config.socketEnabled ? "1" : "0"} | claim=${config.claimEnabled ? "ON" : "OFF"}${lnkPath ? ` | shortcut=${lnkPath}` : ""}`
  );
}

async function cmdStart(id, args) {
  assertValidInstance(id);
  const state = getInstanceState(id);
  if (state.running) {
    console.error(`${id} is already running (PID ${state.pid}) at ${state.userDataPath}`);
    process.exit(1);
  }

  const socketOverride = parseBoolFlag(args, "--socket=");
  const claimOverride = parseBoolFlag(args, "--claim=");
  const { config } = ensureInstanceManifest(id, socketOverride, claimOverride);
  const socketEnabled = Boolean(config.socketEnabled);
  const claimEnabled = Boolean(config.claimEnabled);

  const dir = instanceDir(id);
  const consoleLog = path.join(dir, "logs", "console.log");
  const outFd = openSync(consoleLog, "a");

  const exe = resolveElectronExe();
  const child = spawn(exe, [".", `--instance=${id}`], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: {
      ...process.env,
      RPA_DEV_INSTANCE: id,
      RPA_CAMPAIGN_CLAIM: claimEnabled ? "1" : "0",
      RPA_KEEPALIVE_SOCKET_ENABLE: socketEnabled ? "1" : "0",
    },
  });
  child.unref();
  closeSync(outFd);

  writeFileSync(
    runnerPath(id),
    JSON.stringify(
      {
        instanceId: id,
        pid: child.pid,
        socketEnabled,
        claimEnabled,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  await new Promise((r) => setTimeout(r, 800));
  if (!isPidAlive(child.pid)) {
    console.error(`Failed to start ${id}. Check ${consoleLog}`);
    process.exit(1);
  }
  console.log(
    `Started ${id} (PID ${child.pid}) | userData=${dir} | socket=${socketEnabled ? "1" : "0"} | claim=${claimEnabled ? "ON" : "OFF"}`
  );
}

function killPidTree(pid) {
  if (!isPidAlive(pid)) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

async function cmdStop(target) {
  const ids = target === "all" ? discoverInstances() : [target];
  for (const id of ids) {
    assertValidInstance(id);
    const state = getInstanceState(id);
    if (!state.running) {
      console.log(`${id} is not running.`);
      continue;
    }
    killPidTree(state.pid);
    try {
      unlinkSync(lockPath(id));
    } catch {
      // ignore
    }
    console.log(`Stopped ${id} (PID ${state.pid}).`);
  }
}

async function cmdRestart(id, args) {
  assertValidInstance(id);
  await cmdStop(id);
  await new Promise((r) => setTimeout(r, 400));
  await cmdStart(id, args);
}

function cmdLogs(id, args) {
  assertValidInstance(id);
  const linesCount = Number(parseFlag(args, "--lines=") ?? "50") || 50;
  const logFile = path.join(instanceDir(id), "logs", "client.log");
  if (!existsSync(logFile)) {
    console.log(`No log file yet for ${id} (${logFile}).`);
    return;
  }
  const lines = readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/);
  console.log(lines.slice(-linesCount).join("\n"));
}

function cmdDelete(id, args) {
  assertValidInstance(id);
  if (!hasFlag(args, "--confirm")) {
    console.error(`Refusing to delete ${id} without explicit --confirm flag.`);
    process.exit(1);
  }
  const state = getInstanceState(id);
  if (state.running) {
    console.error(`Cannot delete ${id} while running (PID ${state.pid}). Stop it first.`);
    process.exit(1);
  }
  const dir = instanceDir(id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Deleted instance directory ${dir}`);
  } else {
    console.log(`Instance directory not found: ${dir}`);
  }
  if (existsSync(state.shortcutPath)) {
    unlinkSync(state.shortcutPath);
    console.log(`Deleted Desktop shortcut ${state.shortcutPath}`);
  }
}

function cmdList() {
  for (const id of discoverInstances()) {
    const s = getInstanceState(id);
    console.log(
      `${s.instanceId}: ${s.running ? `RUNNING (pid=${s.pid})` : "STOPPED"} | socket=${s.socketEnabled ? "1" : "0"} | claim=${s.claimEnabled ? "1" : "0"} | nodeId=${s.nodeId ?? "-"} | sqlite=${s.sqliteExists ? "yes" : "no"} | shortcut=${s.shortcutExists ? "yes" : "no"} | userData=${s.userDataPath}`
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/multi-instance.mjs <command> [instance] [options]
Commands:
  create <client-X> [--socket=0|1] [--claim=0|1] [--shortcut]
  start <client-X> [--socket=0|1] [--claim=0|1]
  stop <client-X|all>
  offline <client-X>
  restart <client-X> [--socket=0|1] [--claim=0|1]
  logs <client-X> [--lines=50]
  delete <client-X> --confirm
  list`);
}

const [, , cmd, target, ...rest] = process.argv;
switch (cmd) {
  case "create":
    cmdCreate(target, rest);
    break;
  case "start":
    await cmdStart(target, rest);
    break;
  case "stop":
  case "offline":
    await cmdStop(target);
    break;
  case "restart":
    await cmdRestart(target, rest);
    break;
  case "logs":
    cmdLogs(target, rest);
    break;
  case "delete":
    cmdDelete(target, rest);
    break;
  case "list":
  case "status":
    cmdList();
    break;
  default:
    printHelp();
    process.exit(cmd ? 1 : 0);
}
