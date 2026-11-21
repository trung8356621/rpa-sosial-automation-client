#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_INSTANCES = ["client-A", "client-B", "client-C"];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function instanceDir(id) {
  return path.join(projectRoot, ".local", "instances", id);
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

function getInstanceState(id) {
  const dir = instanceDir(id);
  const lock = readJsonSafe(lockPath(id));
  const runner = readJsonSafe(runnerPath(id));
  const pid = isPidAlive(lock?.pid) ? lock.pid : isPidAlive(runner?.pid) ? runner.pid : null;
  const settings = readJsonSafe(path.join(dir, "settings.json"));
  const sqlitePath = path.join(dir, "keepalive", "keepalive.sqlite");
  return {
    instanceId: id,
    running: pid !== null,
    pid,
    userDataPath: dir,
    socketEnabled: runner?.socketEnabled ?? false,
    nodeId: settings?.keepAliveNodeId ?? null,
    sqliteExists: existsSync(sqlitePath),
  };
}

function resolveElectronExe() {
  if (process.platform === "win32") {
    const exe = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
    if (existsSync(exe)) return exe;
  }
  return path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
}

function assertValidInstance(id) {
  if (!ALLOWED_INSTANCES.includes(id)) {
    console.error(`Invalid instance "${id}". Allowed: ${ALLOWED_INSTANCES.join(", ")}`);
    process.exit(1);
  }
}

function parseFlag(args, prefix) {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function cmdStart(id, args) {
  assertValidInstance(id);
  const state = getInstanceState(id);
  if (state.running) {
    console.error(`${id} is already running (PID ${state.pid}) at ${state.userDataPath}`);
    process.exit(1);
  }

  const prevRunner = readJsonSafe(runnerPath(id));
  const socketFlag = parseFlag(args, "--socket=");
  const socketEnabled =
    socketFlag != null
      ? socketFlag === "1" || socketFlag === "true"
      : Boolean(prevRunner?.socketEnabled ?? false);

  const dir = instanceDir(id);
  const logsDir = path.join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const consoleLog = path.join(logsDir, "console.log");
  const outFd = openSync(consoleLog, "a");

  const exe = resolveElectronExe();
  const child = spawn(exe, [".", `--instance=${id}`], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: {
      ...process.env,
      RPA_DEV_INSTANCE: id,
      RPA_CAMPAIGN_CLAIM: "OFF",
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
        claimEnabled: false,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  // Brief wait to confirm process stays alive
  await new Promise((r) => setTimeout(r, 800));
  if (!isPidAlive(child.pid)) {
    console.error(`Failed to start ${id}. Check ${consoleLog}`);
    process.exit(1);
  }
  console.log(
    `Started ${id} (PID ${child.pid}) | userData=${dir} | socket=${socketEnabled ? "1" : "0"} | claim=OFF`
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
  const ids = target === "all" ? ALLOWED_INSTANCES : [target];
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

function cmdList() {
  for (const id of ALLOWED_INSTANCES) {
    const s = getInstanceState(id);
    console.log(
      `${s.instanceId}: ${s.running ? `RUNNING (pid=${s.pid})` : "STOPPED"} | socket=${s.socketEnabled ? "1" : "0"} | nodeId=${s.nodeId ?? "-"} | sqlite=${s.sqliteExists ? "yes" : "no"} | userData=${s.userDataPath}`
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/multi-instance.mjs <command> [instance] [options]
Commands:
  start <client-A|client-B|client-C> [--socket=0|1]
  stop <client-A|client-B|client-C|all>
  offline <client-A|client-B|client-C>
  restart <client-A|client-B|client-C> [--socket=0|1]
  logs <client-A|client-B|client-C> [--lines=50]
  list`);
}

const [, , cmd, target, ...rest] = process.argv;
switch (cmd) {
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
  case "list":
  case "status":
    cmdList();
    break;
  default:
    printHelp();
    process.exit(cmd ? 1 : 0);
}
