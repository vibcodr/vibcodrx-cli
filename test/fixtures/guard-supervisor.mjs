import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [guardPath, fakeAppServerPath, appServerStatePath, guardStatePath] = process.argv.slice(2);
if (!guardPath || !fakeAppServerPath || !appServerStatePath || !guardStatePath) process.exit(64);

const guard = spawn(
  process.execPath,
  [guardPath, "--", process.execPath, fakeAppServerPath, appServerStatePath],
  {
    detached: process.platform !== "win32",
    stdio: ["pipe", "ignore", "ignore"],
  },
);

guard.once("error", () => process.exit(1));
guard.once("spawn", () => {
  writeFileSync(
    guardStatePath,
    JSON.stringify({ guardPid: guard.pid }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
});
guard.once("exit", () => process.exit(1));

setInterval(() => undefined, 1_000);
