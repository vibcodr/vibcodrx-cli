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
const taskIdSchema = z.string().regex(/^task-[a-zA-Z0-9-]{1,80}$/);
const runtimeAddressSchema = z.string().regex(/^terminal-[A-Za-z0-9_-]{12,100}$/);
const taskStatusSchema = z.enum(["todo", "in_progress", "review", "done"]);
const tiptapContentSchema = z
  .record(z.string(), z.unknown())
  .refine((content) => content.type === "doc", "Conteúdo TipTap inválido.");

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

function tiptapPlainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(tiptapPlainText).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as JsonObject;
  const ownText = typeof record.text === "string" ? record.text : "";
  const children = Array.isArray(record.content)
    ? record.content.map(tiptapPlainText).join("")
    : "";
  const blockBreak = record.type === "paragraph" || record.type === "heading" ? "\n" : "";
  return `${ownText}${children}${blockBreak}`;
}

function withPlainText<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as JsonObject;
  if (!record.content || typeof record.content !== "object") return value;
  return {
    ...record,
    plainText: tiptapPlainText(record.content).replace(/\n+$/g, ""),
  } as T;
}

function withEntityPlainText<T>(value: T, key: "note" | "task"): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as JsonObject;
  if (!record[key] || typeof record[key] !== "object" || Array.isArray(record[key])) {
    return value;
  }
  return { ...record, [key]: withPlainText(record[key]) } as T;
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

function runtimeContext(): { address: string; capability: string } {
  const address = process.env.VIBCODRX_RUNTIME_ADDRESS;
  const capability = process.env.VIBCODRX_RUNTIME_CAPABILITY;
  if (!address || !capability) {
    throw new Error(
      "Esta sessão Codex não foi iniciada pelo runtime distribuído do Vibcodrx. Execute `vibcodrx`, abra um novo shell e inicie `codex` novamente.",
    );
  }
  return {
    address: runtimeAddressSchema.parse(address),
    capability: z.string().min(32).max(256).parse(capability),
  };
}

function runtimeWorkspaceId(): string {
  const workspaceId = process.env.VIBCODRX_RUNTIME_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error(
      "O projeto atual ainda não está vinculado a um Workspace Vibcodrx. Abra o mesmo projeto no desktop e sincronize o Workspace antes de usar esta ferramenta.",
    );
  }
  return workspaceIdSchema.parse(workspaceId);
}

async function readNoteRevision(
  session: StoredSession,
  input: { workspaceId: string; terminalId: string; noteId: string },
): Promise<number> {
  const note = await sessionApiRequest<JsonObject>(session, "/v1/mcp/notes/read", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.number().int().min(1).parse(
    note.note && typeof note.note === "object" && !Array.isArray(note.note)
      ? (note.note as JsonObject).revision
      : undefined,
  );
}

async function readTaskRevision(
  session: StoredSession,
  workspaceId: string,
  taskId: string,
): Promise<number> {
  const task = await sessionApiRequest<JsonObject>(session, "/v1/mcp/tasks/read", {
    method: "POST",
    body: JSON.stringify({ workspaceId, taskId }),
  });
  return z.number().int().min(1).parse(
    task.task && typeof task.task === "object" && !Array.isArray(task.task)
      ? (task.task as JsonObject).revision
      : undefined,
  );
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
        "Este MCP significa que a sessão Codex está no harness Vibcodrx em um host autenticado. O backend fornece o estado persistido do desktop e o runtime vivo dos Terminais locais/remotos. Use list_available_threads imediatamente antes de send_message e somente o address retornado; evite loopings, se não for necessário responder, não responda. Para estado persistido, comece por list_workspaces e get_workspace_context. Anotações exigem terminalId ligado por corda; nunca invente IDs. Tasks pertencem ao Workspace resolvido deste projeto. O filesystem não passa por este MCP.",
    },
  );

  server.registerTool(
    "list_workspaces",
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
    "get_workspace_context",
    {
      title: "Obter contexto de workspace",
      description:
        "Retorna nodes, cordas e tarefas persistidos de um workspace. O conteúdo das Anotações permanece protegido pela corda do Terminal.",
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
        const workspaceId = runtimeWorkspaceId();
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
    "list_available_threads",
    {
      title: "Listar Terminais Codex conectados",
      description:
        "Fonte atual das sessões Codex vivas no tenant, locais ou remotas. Chame imediatamente antes de enviar e use somente address.",
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
        const runtime = runtimeContext();
        return textResult(
          await sessionApiRequest(session, "/v1/runtime/threads", {
            method: "POST",
            body: JSON.stringify({
              senderAddress: runtime.address,
              senderCapability: runtime.capability,
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Enviar mensagem a outro Terminal Codex",
      description:
        "Envia contexto ao address da última listagem. replyTo responde ao ID recebido. Evite loopings, se não for necessário responder, não responda.",
      inputSchema: z
        .object({
          target: runtimeAddressSchema,
          content: z.string().trim().min(1).max(8_000),
          replyTo: z.string().regex(/^msg_[0-9a-f-]{36}$/).optional(),
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
        const runtime = runtimeContext();
        return textResult(
          await sessionApiRequest(session, "/v1/runtime/messages", {
            method: "POST",
            body: JSON.stringify({
              senderAddress: runtime.address,
              senderCapability: runtime.capability,
              target: input.target,
              content: input.content,
              ...(input.replyTo ? { replyTo: input.replyTo } : {}),
              idempotencyKey: randomUUID(),
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_connected_notes",
    {
      title: "Listar Anotações conectadas",
      description:
        "Lista somente Anotações que possuem uma corda persistida partindo do Terminal informado.",
      inputSchema: z
        .object({ terminalId: nodeIdSchema })
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
            body: JSON.stringify({ workspaceId: runtimeWorkspaceId(), ...input }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "read_connected_note",
    {
      title: "Ler Anotação conectada",
      description:
        "Lê título, conteúdo TipTap e revision de uma Anotação autorizada pela corda do Terminal.",
      inputSchema: z
        .object({
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
        return textResult(withEntityPlainText(
          await sessionApiRequest(session, "/v1/mcp/notes/read", {
            method: "POST",
            body: JSON.stringify({ workspaceId: runtimeWorkspaceId(), ...input }),
          }),
          "note",
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "create_connected_note",
    {
      title: "Criar Anotação conectada",
      description:
        "Cria uma Anotação e sua corda a partir do Terminal informado numa única operação atômica.",
      inputSchema: z
        .object({
          terminalId: nodeIdSchema,
          title: z.string().trim().min(1).max(120),
          content: z.string().max(40_000).default(""),
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
              workspaceId: runtimeWorkspaceId(),
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
    "update_connected_note",
    {
      title: "Atualizar Anotação conectada",
      description:
        "Atualiza título e/ou conteúdo textual de uma Anotação conectada. Revalida a corda e a revision no servidor antes de escrever.",
      inputSchema: z
        .object({
          terminalId: nodeIdSchema,
          noteId: nodeIdSchema,
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
    async ({ content, ...input }) => {
      try {
        const session = await getSession();
        const workspaceId = runtimeWorkspaceId();
        const revision = await readNoteRevision(session, { workspaceId, ...input });
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/update", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
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
    "delete_connected_note",
    {
      title: "Excluir Anotação conectada",
      description:
        "Exclui uma Anotação conectada e suas cordas após revalidar a capability e a revision no servidor.",
      inputSchema: z
        .object({
          terminalId: nodeIdSchema,
          noteId: nodeIdSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const session = await getSession();
        const workspaceId = runtimeWorkspaceId();
        const revision = await readNoteRevision(session, { workspaceId, ...input });
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/notes/delete", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
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

  server.registerTool(
    "list_tasks",
    {
      title: "Listar Tasks",
      description:
        "Lista Tasks do Workspace atual com paginação e filtro opcional; use antes de ler ou alterar uma Task.",
      inputSchema: z
        .object({
          status: taskStatusSchema.optional(),
          offset: z.number().int().min(0).max(10_000).default(0),
          limit: z.number().int().min(1).max(100).default(50),
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
          await sessionApiRequest(session, "/v1/mcp/tasks/list", {
            method: "POST",
            body: JSON.stringify({ workspaceId: runtimeWorkspaceId(), ...input }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "read_task",
    {
      title: "Ler Task",
      description:
        "Lê uma Task do Workspace atual e retorna metadata, documento TipTap, plainText e revision.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }) => {
      try {
        const session = await getSession();
        return textResult(withEntityPlainText(
          await sessionApiRequest(session, "/v1/mcp/tasks/read", {
            method: "POST",
            body: JSON.stringify({ workspaceId: runtimeWorkspaceId(), taskId }),
          }),
          "task",
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Criar Task",
      description:
        "Cria Task ou subtarefa no Workspace atual; parentId deve vir de list_tasks. Use contentDocument no lugar de content para preservar TipTap.",
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(200),
          parentId: taskIdSchema.nullable().default(null),
          status: taskStatusSchema.default("todo"),
          content: z.string().max(40_000).optional(),
          contentDocument: tiptapContentSchema.optional(),
        })
        .strict()
        .refine(
          (value) => value.content === undefined || value.contentDocument === undefined,
          "Use content ou contentDocument, nunca ambos.",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ content, contentDocument, ...input }) => {
      try {
        const session = await getSession();
        const mutationId = randomUUID();
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/tasks/create", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: runtimeWorkspaceId(),
              ...input,
              taskId: `task-${mutationId}`,
              operationId: `mcp-task-${mutationId}`,
              content: contentDocument ?? plainTextDocument(content ?? ""),
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Atualizar Task",
      description:
        "Atualiza título, status e/ou conteúdo de uma Task após revalidar sua revision no servidor.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          title: z.string().trim().min(1).max(200).optional(),
          status: taskStatusSchema.optional(),
          content: z.string().max(40_000).optional(),
          contentDocument: tiptapContentSchema.optional(),
        })
        .strict()
        .refine(
          (value) => value.content === undefined || value.contentDocument === undefined,
          "Use content ou contentDocument, nunca ambos.",
        )
        .refine(
          (value) =>
            value.title !== undefined ||
            value.status !== undefined ||
            value.content !== undefined ||
            value.contentDocument !== undefined,
          "Informe ao menos um campo para atualizar.",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, content, contentDocument, ...input }) => {
      try {
        const session = await getSession();
        const workspaceId = runtimeWorkspaceId();
        const revision = await readTaskRevision(session, workspaceId, taskId);
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/tasks/update", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              taskId,
              ...input,
              operationId: `mcp-task-${randomUUID()}`,
              baseRevision: revision,
              ...(contentDocument !== undefined
                ? { content: contentDocument }
                : content !== undefined
                  ? { content: plainTextDocument(content) }
                  : {}),
            }),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Excluir Task",
      description:
        "Exclui uma Task e toda a descendência após revalidar sua revision no servidor.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId }) => {
      try {
        const session = await getSession();
        const workspaceId = runtimeWorkspaceId();
        const revision = await readTaskRevision(session, workspaceId, taskId);
        return textResult(
          await sessionApiRequest(session, "/v1/mcp/tasks/delete", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              taskId,
              operationId: `mcp-task-${randomUUID()}`,
              baseRevision: revision,
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
