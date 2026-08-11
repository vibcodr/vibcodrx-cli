import { randomUUID } from "node:crypto";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { sessionApiRequest } from "./api.js";
import { loadSession, type StoredSession } from "./config.js";
import { packageVersion } from "./constants.js";
import { getProjectIdentity } from "./project.js";

const workspaceIdSchema = z.string().regex(/^workspace-[a-zA-Z0-9-]{1,80}$/);
const nodeIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,100}$/);

type JsonObject = Record<string, unknown>;

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function plainTextDocument(content: string): JsonObject {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

function createSessionLoader(): () => Promise<StoredSession> {
  let pending: Promise<StoredSession | null> | null = null;
  return async () => {
    pending ??= loadSession();
    const session = await pending;
    if (!session) {
      throw new Error("Vibcodrx não está autenticado neste host. Execute `vibcodrx login`.");
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error("A sessão Vibcodrx expirou. Execute `vibcodrx login` novamente.");
    }
    return session;
  };
}

export function createVibcodrxMcpServer(cwd: string): McpServer {
  const getSession = createSessionLoader();
  const getInventory = async (): Promise<JsonObject> => {
    const session = await getSession();
    return sessionApiRequest<JsonObject>(session, "/v1/mcp/inventory");
  };
  const server = new McpServer(
    { name: "vibcodrx", version: packageVersion },
    {
      instructions:
        "Vibcodrx fornece o estado persistido do usuário no host remoto. Comece por vibcodrx_list_workspaces e vibcodrx_get_workspace_context. O conteúdo de Anotações exige workspaceId e terminalId ligados por uma corda persistida; nunca invente IDs. Escritas devem usar a revision retornada pela leitura anterior e conflitos devem ser mostrados ao usuário. O filesystem não passa por este MCP.",
    },
  );

  server.registerTool(
    "vibcodrx_list_workspaces",
    {
      title: "Listar workspaces Vibcodrx",
      description:
        "Lista os workspaces do tenant autenticado e sugere o correspondente ao projeto Git atual quando houver vínculo portátil.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const session = await getSession();
        const [inventory, project] = await Promise.all([
          getInventory(),
          getProjectIdentity(cwd),
        ]);
        const resolved = await sessionApiRequest<JsonObject>(session, "/v1/projects/resolve", {
          method: "POST",
          body: JSON.stringify(project),
        });
        return textResult({
          suggestedWorkspace: resolved.match ?? null,
          project: { label: project.label, fingerprintVersion: project.fingerprintVersion },
          workspaces: inventory.workspaces ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_get_workspace_context",
    {
      title: "Obter contexto de workspace",
      description:
        "Retorna nodes, cordas e tarefas persistidos de um workspace. O conteúdo das Anotações permanece protegido pela corda do Terminal.",
      inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      try {
        const inventory = await getInventory();
        const workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : [];
        const workspace = workspaces.find(
          (entry) => typeof entry === "object" && entry !== null && (entry as JsonObject).id === workspaceId,
        );
        if (!workspace) throw new Error("Workspace não encontrado no tenant autenticado.");
        const filterWorkspace = (value: unknown): boolean =>
          typeof value === "object" && value !== null && (value as JsonObject).workspaceId === workspaceId;
        return textResult({
          workspace,
          nodes: Array.isArray(inventory.nodes) ? inventory.nodes.filter(filterWorkspace) : [],
          edges: Array.isArray(inventory.edges) ? inventory.edges.filter(filterWorkspace) : [],
          tasks: Array.isArray(inventory.tasks) ? inventory.tasks.filter(filterWorkspace) : [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_list_connected_notes",
    {
      title: "Listar Anotações conectadas",
      description:
        "Lista somente Anotações que possuem uma corda persistida partindo do Terminal informado.",
      inputSchema: z
        .object({ workspaceId: workspaceIdSchema, terminalId: nodeIdSchema })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const session = await getSession();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/list", {
            method: "POST",
            body: JSON.stringify(input),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_read_note",
    {
      title: "Ler Anotação conectada",
      description:
        "Lê título, conteúdo TipTap e revision de uma Anotação autorizada pela corda do Terminal.",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          terminalId: nodeIdSchema,
          noteId: nodeIdSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const session = await getSession();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/read", {
            method: "POST",
            body: JSON.stringify(input),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_create_note",
    {
      title: "Criar Anotação conectada",
      description:
        "Cria uma Anotação e sua corda a partir do Terminal informado numa única operação atômica.",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          terminalId: nodeIdSchema,
          title: z.string().trim().min(1).max(120),
          content: z.string().max(40_000),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const session = await getSession();
        const mutationId = randomUUID();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/create", {
            method: "POST",
            body: JSON.stringify({
              ...input,
              content: plainTextDocument(input.content),
              noteId: `note-${mutationId}`,
              edgeId: `edge-${mutationId}`,
              noteOperationId: `mcp-note-${mutationId}`,
              edgeOperationId: `mcp-edge-${mutationId}`,
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_update_note",
    {
      title: "Atualizar Anotação conectada",
      description:
        "Atualiza título e/ou conteúdo textual de uma Anotação conectada. Use a revision retornada por vibcodrx_read_note.",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          terminalId: nodeIdSchema,
          noteId: nodeIdSchema,
          revision: z.number().int().min(1),
          title: z.string().trim().min(1).max(120).optional(),
          content: z.string().max(40_000).optional(),
        })
        .strict()
        .refine(
          (value) => value.title !== undefined || value.content !== undefined,
          "Informe título ou conteúdo.",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ revision, content, ...input }) => {
      try {
        const session = await getSession();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/update", {
            method: "POST",
            body: JSON.stringify({
              ...input,
              baseRevision: revision,
              operationId: `mcp-${randomUUID()}`,
              ...(content === undefined ? {} : { content: plainTextDocument(content) }),
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vibcodrx_delete_note",
    {
      title: "Excluir Anotação conectada",
      description:
        "Exclui uma Anotação conectada e suas cordas. Use a revision retornada por vibcodrx_read_note.",
      inputSchema: z
        .object({
          workspaceId: workspaceIdSchema,
          terminalId: nodeIdSchema,
          noteId: nodeIdSchema,
          revision: z.number().int().min(1),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ revision, ...input }) => {
      try {
        const session = await getSession();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/delete", {
            method: "POST",
            body: JSON.stringify({
              ...input,
              baseRevision: revision,
              operationId: `mcp-${randomUUID()}`,
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function runMcpServer(cwd = process.cwd()): Promise<void> {
  const handle = serveStdio(() => createVibcodrxMcpServer(cwd), {
    onerror: (error) => console.error(`Vibcodrx MCP: ${error.message}`),
  });
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.stdin.once("end", close);
    process.stdin.once("close", close);
  });
}
