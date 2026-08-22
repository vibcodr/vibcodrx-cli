import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeApiUrl } from "../src/api.js";
import { runCli } from "../src/cli.js";
import {
  cliExecutableCommand,
  isExpectedCodexMcpEntry,
} from "../src/codex.js";
import { createVibcodrxMcpServer } from "../src/mcp.js";
import { sanitizeRemoteUrl } from "../src/project.js";
import {
  materializeRuntimeClipboardImage,
  runtimeTerminalBindingSequence,
  runtimeTerminalUnbindingSequence,
  runtimeWorkspaceRetryDelayMs,
} from "../src/runtime.js";

describe("Vibcodrx CLI", () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  });

  it("aceita HTTPS público e limita HTTP a loopback", () => {
    expect(normalizeApiUrl("https://api.vibcodrx.app/"))
      .toBe("https://api.vibcodrx.app");
    expect(normalizeApiUrl("http://127.0.0.1:4100"))
      .toBe("http://127.0.0.1:4100");
    expect(() => normalizeApiUrl("http://example.com"))
      .toThrow(/HTTPS/);
  });

  it("fixa o MCP no executável absoluto da CLI em vez de depender do PATH", () => {
    const command = "/opt/vibcodrx/bin/vibcodrx";
    expect(cliExecutableCommand(command)).toBe(command);
    expect(isExpectedCodexMcpEntry({
      enabled: true,
      transport: { type: "stdio", command, args: ["mcp"] },
    }, command)).toBe(true);
    expect(isExpectedCodexMcpEntry({
      enabled: true,
      transport: { type: "stdio", command: "vibcodrx", args: ["mcp"] },
    }, command)).toBe(false);
  });

  it("remove usuário, senha e sufixo Git do remote antes do fingerprint", () => {
    expect(sanitizeRemoteUrl("git@github.com:vibcodr/vibcodrx.git"))
      .toBe("ssh://github.com/vibcodr/vibcodrx");
    expect(sanitizeRemoteUrl("https://token@example.com/org/repo.git?secret=1"))
      .toBe("https://example.com/org/repo");
  });

  it("materializa imagem remota em arquivo privado e rejeita assinatura falsa", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibcodrx-cli-test-"));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const path = await materializeRuntimeClipboardImage(directory, png, "image/png");
      expect(await readFile(path)).toEqual(png);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(materializeRuntimeClipboardImage(
        directory,
        Buffer.from("not-an-image"),
        "image/png",
      )).rejects.toThrow(/signature/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("limita o backoff da resolução tardia de Workspace", () => {
    expect(runtimeWorkspaceRetryDelayMs(-1)).toBe(1_000);
    expect(runtimeWorkspaceRetryDelayMs(0)).toBe(1_000);
    expect(runtimeWorkspaceRetryDelayMs(1)).toBe(2_000);
    expect(runtimeWorkspaceRetryDelayMs(4)).toBe(16_000);
    expect(runtimeWorkspaceRetryDelayMs(20)).toBe(30_000);
  });

  it("anuncia o endereço do runtime pelo canal privado do Terminal", () => {
    const address = "terminal-runtime123456";
    expect(runtimeTerminalBindingSequence(address)).toBe(
      `\u001b]777;vibcodrx;remote-runtime;bind;${address}\u0007`,
    );
    expect(runtimeTerminalUnbindingSequence(address)).toBe(
      `\u001b]777;vibcodrx;remote-runtime;clear;${address}\u0007`,
    );
  });

  it("trata ajuda após um subcomando sem executar a ação", async () => {
    const output: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    try {
      await runCli(["logout", "--help"]);
    } finally {
      write.mockRestore();
    }
    expect(output.join("")).toContain("Vibcodrx CLI");
    expect(output.join("")).not.toContain("Sessão Vibcodrx encerrada");
  });

  it("não oferece mais um comando de supervisão do Codex", async () => {
    await expect(runCli(["codex", "--"])).rejects.toThrow(/Comando desconhecido/);
  });

  it("conclui o handshake e lista ferramentas mesmo sem rede ou login", async () => {
    process.env.XDG_CONFIG_HOME = `/tmp/vibcodrx-cli-test-no-session-${process.pid}`;
    const server = createVibcodrxMcpServer(process.cwd());
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_workspaces",
        "get_workspace_context",
        "list_available_threads",
        "send_message",
        "list_incoming_messages",
        "list_connected_notes",
        "read_connected_note",
        "create_connected_note",
        "update_connected_note",
        "delete_connected_note",
        "list_tasks",
        "read_task",
        "create_task",
        "update_task",
        "delete_task",
      ]);
      const result = await client.callTool({
        name: "list_workspaces",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("vibcodrx login");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
