import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
  options: {
    input?: string;
    inherit?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish({ exitCode: 124, stdout, stderr: stderr || "Tempo limite excedido." });
        }, options.timeoutMs)
      : null;
    timer?.unref();

    if (!options.inherit) {
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-2_000_000);
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-200_000);
      });
      if (options.input !== undefined) child.stdin!.end(options.input);
      else child.stdin!.end();
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) =>
      finish({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
