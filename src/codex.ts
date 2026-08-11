import { createInterface } from "node:readline/promises";

import { mcpServerName } from "./constants.js";
import { commandExists, runCommand } from "./process.js";

type CodexMcpEntry = {
  name?: unknown;
  enabled?: unknown;
  transport?: {
    type?: unknown;
    command?: unknown;
    args?: unknown;
  };
};

export async function getCodexVersion(): Promise<string | null> {
  if (!(await commandExists("codex"))) return null;
  const result = await runCommand("codex", ["--version"], { timeoutMs: 5_000 });
  return result.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : null;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [S/n] `)).trim().toLocaleLowerCase();
    return answer === "" || answer === "s" || answer === "sim" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

export async function ensureCodexInstalled(): Promise<string> {
  const existing = await getCodexVersion();
  if (existing) return existing;

  if (!(await confirm("Codex não foi encontrado. Instalar agora pelo pacote oficial @openai/codex?"))) {
    throw new Error("Instale o Codex com `npm install -g @openai/codex` e execute `vibcodrx` novamente.");
  }
  const installed = await runCommand("npm", ["install", "-g", "@openai/codex"], {
    inherit: true,
  });
  if (installed.exitCode !== 0) {
    throw new Error("A instalação do Codex não foi concluída.");
  }
  const version = await getCodexVersion();
  if (!version) throw new Error("Codex foi instalado, mas ainda não está disponível no PATH.");
  return version;
}

export async function getCodexMcpEntry(): Promise<CodexMcpEntry | null> {
  const result = await runCommand(
    "codex",
    ["mcp", "get", mcpServerName, "--json"],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return null;
  try {
    return JSON.parse(result.stdout) as CodexMcpEntry;
  } catch {
    throw new Error("Codex devolveu uma configuração MCP inválida.");
  }
}

function isExpectedEntry(entry: CodexMcpEntry | null): boolean {
  return Boolean(
    entry &&
      entry.enabled !== false &&
      entry.transport?.type === "stdio" &&
      entry.transport.command === "vibcodrx" &&
      Array.isArray(entry.transport.args) &&
      entry.transport.args.length === 1 &&
      entry.transport.args[0] === "mcp",
  );
}

export async function configureCodexMcp(): Promise<"unchanged" | "configured"> {
  const existing = await getCodexMcpEntry();
  if (isExpectedEntry(existing)) return "unchanged";

  if (existing) {
    const removed = await runCommand("codex", ["mcp", "remove", mcpServerName], {
      timeoutMs: 10_000,
    });
    if (removed.exitCode !== 0) {
      throw new Error(removed.stderr.trim() || "Não foi possível corrigir o MCP Vibcodrx existente.");
    }
  }
  const added = await runCommand(
    "codex",
    ["mcp", "add", mcpServerName, "--", "vibcodrx", "mcp"],
    { timeoutMs: 10_000 },
  );
  if (added.exitCode !== 0) {
    throw new Error(added.stderr.trim() || "Não foi possível registrar o MCP no Codex.");
  }
  if (!isExpectedEntry(await getCodexMcpEntry())) {
    throw new Error("O Codex não confirmou a configuração esperada do MCP Vibcodrx.");
  }
  return "configured";
}
