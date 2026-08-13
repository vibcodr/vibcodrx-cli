import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const shutdownGraceMilliseconds = 1_000;
const descendantSettleMilliseconds = 100;
const processCensusMilliseconds = 1_000;

const guardArguments = process.argv.slice(2);
if (guardArguments[0] === "--") guardArguments.shift();

const command = guardArguments.shift();
if (!command) process.exit(64);

let appServer: ChildProcess;
try {
  appServer = spawn(command, guardArguments, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
} catch {
  process.exit(1);
}

let shuttingDown = false;
let forceTimer: NodeJS.Timeout | null = null;
let settleTimer: NodeJS.Timeout | null = null;
const managedProcesses = new Map<number, { startTime: string }>();

function readLinuxProcessIdentity(pid: number): {
  pid: number;
  parentPid: number;
  sessionId: number;
  startTime: string;
} | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const sessionId = Number(fields[3]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(sessionId) || !startTime) {
      return null;
    }
    return { pid, parentPid, sessionId, startTime };
  } catch {
    return null;
  }
}

function captureManagedProcesses(): void {
  if (process.platform !== "linux") return;
  let processIds: number[];
  try {
    processIds = readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return;
  }
  const identities = processIds
    .map(readLinuxProcessIdentity)
    .filter((identity): identity is NonNullable<typeof identity> => identity !== null);
  const selected = new Set<number>([process.pid]);
  for (const identity of identities) {
    if (identity.sessionId === process.pid) selected.add(identity.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of identities) {
      if (!selected.has(identity.pid) && selected.has(identity.parentPid)) {
        selected.add(identity.pid);
        changed = true;
      }
    }
  }
  for (const identity of identities) {
    if (identity.pid !== process.pid && selected.has(identity.pid)) {
      managedProcesses.set(identity.pid, { startTime: identity.startTime });
    }
  }
}

function signalKnownManagedProcesses(signal: NodeJS.Signals): boolean {
  captureManagedProcesses();
  let signaled = false;
  for (const [pid, expected] of managedProcesses) {
    const current = readLinuxProcessIdentity(pid);
    if (!current || current.startTime !== expected.startTime) {
      managedProcesses.delete(pid);
      continue;
    }
    try {
      process.kill(pid, signal);
      signaled = true;
    } catch {
      // The process may have exited between the identity check and the signal.
    }
  }
  return signaled;
}

function forceManagedProcesses(): void {
  if (process.platform === "linux") signalKnownManagedProcesses("SIGKILL");
  else if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  if (appServer.pid !== undefined) {
    try {
      appServer.kill("SIGKILL");
    } catch {
      // The direct child may already have exited.
    }
  }
  process.exit(1);
}

function signalManagedProcesses(signal: NodeJS.Signals): void {
  if (process.platform === "linux" && signalKnownManagedProcesses(signal)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is unavailable.
    }
  }
  if (appServer.pid !== undefined) {
    try {
      appServer.kill(signal);
    } catch {
      // The direct child may already have exited.
    }
  }
}

function beginShutdown(signal: NodeJS.Signals = "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  signalManagedProcesses(signal);
  forceTimer = setTimeout(forceManagedProcesses, shutdownGraceMilliseconds);
}

function settleAfterChildExit(): void {
  if (!shuttingDown) beginShutdown("SIGTERM");
  if (settleTimer !== null) return;
  settleTimer = setTimeout(() => {
    if (forceTimer !== null) clearTimeout(forceTimer);
    forceManagedProcesses();
  }, descendantSettleMilliseconds);
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => beginShutdown(signal));
}

process.stdin.resume();
process.stdin.once("end", () => beginShutdown("SIGTERM"));
process.stdin.once("close", () => beginShutdown("SIGTERM"));
process.stdin.once("error", () => beginShutdown("SIGTERM"));

// Retain exact process identities so even descendants that create another
// process group or session remain inside this guard's cleanup boundary.
const censusTimer = setInterval(captureManagedProcesses, processCensusMilliseconds);
censusTimer.unref();
captureManagedProcesses();

appServer.once("error", settleAfterChildExit);
appServer.once("exit", settleAfterChildExit);
