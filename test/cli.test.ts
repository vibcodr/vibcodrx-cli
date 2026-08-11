import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeApiUrl } from "../src/api.js";
import { runCli } from "../src/cli.js";
import { createVibcodrxMcpServer } from "../src/mcp.js";
import { sanitizeRemoteUrl } from "../src/project.js";

describe("Vibcodrx CLI", () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalRuntimeAddress = process.env.VIBCODRX_RUNTIME_ADDRESS;
  const originalRuntimeCapability = process.env.VIBCODRX_RUNTIME_CAPABILITY;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalRuntimeAddress === undefined) delete process.env.VIBCODRX_RUNTIME_ADDRESS;
    else process.env.VIBCODRX_RUNTIME_ADDRESS = originalRuntimeAddress;
    if (originalRuntimeCapability === undefined) delete process.env.VIBCODRX_RUNTIME_CAPABILITY;
    else process.env.VIBCODRX_RUNTIME_CAPABILITY = originalRuntimeCapability;
  });

  it("aceita HTTPS público e limita HTTP a loopback", () => {
    expect(normalizeApiUrl("https://api.vibcodrx.app/"))
      .toBe("https://api.vibcodrx.app");
    expect(normalizeApiUrl("http://127.0.0.1:4100"))
      .toBe("http://127.0.0.1:4100");
    expect(() => normalizeApiUrl("http://example.com"))
      .toThrow(/HTTPS/);
  });

  it("remove usuário, senha e sufixo Git do remote antes do fingerprint", () => {
    expect(sanitizeRemoteUrl("git@github.com:vibcodr/vibcodrx.git"))
      .toBe("ssh://github.com/vibcodr/vibcodrx");
    expect(sanitizeRemoteUrl("https://token@example.com/org/repo.git?secret=1"))
      .toBe("https://example.com/org/repo");
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
