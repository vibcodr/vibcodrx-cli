import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const statePath = process.argv[2];
if (!statePath) process.exit(64);

const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => undefined, 1_000)"],
  { detached: process.platform !== "win32", stdio: "ignore" },
);

descendant.once("error", () => process.exit(1));
descendant.once("spawn", () => {
  writeFileSync(
    statePath,
    JSON.stringify({ appServerPid: process.pid, descendantPid: descendant.pid }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
});

setInterval(() => undefined, 1_000);
