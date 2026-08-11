import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const startMarker = "# >>> vibcodrx managed codex >>>";
const endMarker = "# <<< vibcodrx managed codex <<<";

function launcherBlock(): string {
  return [
    startMarker,
    "unalias codex 2>/dev/null || true",
    "codex() {",
    "  command vibcodrx codex -- \"$@\"",
    "}",
    endMarker,
  ].join("\n");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function replaceBlock(content: string, block: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start !== -1 && end >= start) {
    const after = end + endMarker.length;
    return `${content.slice(0, start).trimEnd()}\n\n${block}${content.slice(after)}`
      .replace(/^\n+/, "")
      .replace(/\n*$/, "\n");
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${block}\n`;
}

export async function configureCodexLauncher(): Promise<{
  status: "configured" | "unchanged" | "unsupported";
  profilePath: string | null;
}> {
  const shell = basename(process.env.SHELL || "bash");
  const profileName = shell === "zsh" ? ".zshrc" : shell === "bash" ? ".bashrc" : null;
  if (!profileName) return { status: "unsupported", profilePath: null };

  const profilePath = join(homedir(), profileName);
  const current = await readOptional(profilePath);
  const next = replaceBlock(current, launcherBlock());
  if (current === next) return { status: "unchanged", profilePath };
  await writeFile(profilePath, next, { mode: 0o600 });
  return { status: "configured", profilePath };
}
