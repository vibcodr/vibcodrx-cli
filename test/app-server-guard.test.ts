import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type ManagedPids = {
  appServerPid: number;
  descendantPid: number;
};

const guardPath = process.env.VIBCODRX_TEST_APP_SERVER_GUARD_PATH ??
  fileURLToPath(new URL("../src/app-server-guard.ts", import.meta.url));
const fakeAppServerPath = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
const supervisorPath = fileURLToPath(new URL("./fixtures/guard-supervisor.mjs", import.meta.url));

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function killExactPid(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may have exited between the probe and the signal.
  }
}

function killExactGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may already be gone.
  }
}

async function waitForJson<T>(path: string, timeoutMilliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessesToExit(pids: number[], timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Processes still alive: ${pids.filter(isProcessAlive).join(", ")}`);
}

async function spawnGuard(directory: string): Promise<{
  guard: ChildProcess;
  guardPid: number;
  managedPids: ManagedPids;
}> {
  const statePath = join(directory, "managed.json");
  const guard = spawn(
    process.execPath,
    [guardPath, "--", process.execPath, fakeAppServerPath, statePath],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  await once(guard, "spawn");
  if (guard.pid === undefined) throw new Error("Guard PID unavailable");
  return {
    guard,
    guardPid: guard.pid,
    managedPids: await waitForJson<ManagedPids>(statePath),
  };
}

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("Codex App Server lifecycle guard", () => {
  it("encerra a árvore inteira na saída normal do supervisor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibcodrx-guard-test-"));
    let guardPid: number | undefined;
    let managedPids: ManagedPids | undefined;
    try {
      const started = await spawnGuard(directory);
      guardPid = started.guardPid;
      managedPids = started.managedPids;
      started.guard.stdin?.end();

      await waitForProcessesToExit([
        guardPid,
        managedPids.appServerPid,
        managedPids.descendantPid,
      ]);
    } finally {
      killExactGroup(guardPid);
      killExactPid(managedPids?.appServerPid);
      killExactPid(managedPids?.descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("encerra a árvore inteira quando recebe SIGHUP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibcodrx-guard-test-"));
    let guardPid: number | undefined;
    let managedPids: ManagedPids | undefined;
    try {
      const started = await spawnGuard(directory);
      guardPid = started.guardPid;
      managedPids = started.managedPids;
      process.kill(guardPid, "SIGHUP");

      await waitForProcessesToExit([
        guardPid,
        managedPids.appServerPid,
        managedPids.descendantPid,
      ]);
    } finally {
      killExactGroup(guardPid);
      killExactPid(managedPids?.appServerPid);
      killExactPid(managedPids?.descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("encerra a árvore inteira após SIGKILL do supervisor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibcodrx-guard-test-"));
    const appServerStatePath = join(directory, "managed.json");
    const guardStatePath = join(directory, "guard.json");
    let supervisor: ChildProcess | undefined;
    let guardPid: number | undefined;
    let managedPids: ManagedPids | undefined;
    try {
      supervisor = spawn(
        process.execPath,
        [supervisorPath, guardPath, fakeAppServerPath, appServerStatePath, guardStatePath],
        { stdio: "ignore" },
      );
      await once(supervisor, "spawn");
      const guardState = await waitForJson<{ guardPid: number }>(guardStatePath);
      guardPid = guardState.guardPid;
      managedPids = await waitForJson<ManagedPids>(appServerStatePath);
      if (supervisor.pid === undefined) throw new Error("Supervisor PID unavailable");

      const supervisorExit = once(supervisor, "exit");
      process.kill(supervisor.pid, "SIGKILL");
      await supervisorExit;
      await waitForProcessesToExit([
        guardPid,
        managedPids.appServerPid,
        managedPids.descendantPid,
      ]);

      expect(isProcessAlive(supervisor.pid)).toBe(false);
    } finally {
      killExactPid(supervisor?.pid);
      killExactGroup(guardPid);
      killExactPid(managedPids?.appServerPid);
      killExactPid(managedPids?.descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
