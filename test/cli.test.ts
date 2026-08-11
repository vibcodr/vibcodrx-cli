import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeApiUrl } from "../src/api.js";
import { runCli } from "../src/cli.js";
import { createVibcodrxMcpServer } from "../src/mcp.js";
import { sanitizeRemoteUrl } from "../src/project.js";

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
      expect(tools.tools.map((tool) => tool.name)).toContain("vibcodrx_list_workspaces");
      expect(tools.tools.map((tool) => tool.name)).toContain("vibcodrx_create_note");
      const result = await client.callTool({
        name: "vibcodrx_list_workspaces",
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
