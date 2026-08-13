import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { sessionApiRequest } from "./api.js";
import { loadSession, type StoredSession } from "./config.js";
import { packageVersion } from "./constants.js";
import { getProjectIdentity } from "./project.js";

type JsonObject = Record<string, unknown>;
type RuntimePresence = "idle" | "running" | "waiting-user" | "offline";
type ThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags: string[] };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkspaceContext = {
  id?: string;
  name: string;
};

type RuntimeClipboardMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

type IncomingClipboardTransfer = {
  mimeType: RuntimeClipboardMimeType;
  size: number;
  chunkCount: number;
  chunks: Array<Buffer | undefined>;
  receivedBytes: number;
  timer: NodeJS.Timeout;
};

const maximumRuntimeClipboardImageBytes = 25 * 1_024 * 1_024;
const maximumRuntimeClipboardChunkCharacters = 70_000;
const runtimeClipboardTransferIdPattern = /^clipboard_[0-9a-f-]{36}$/;
const runtimeClipboardMimeTypes = new Set<RuntimeClipboardMimeType>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const runtimeClipboardExtensions: Record<RuntimeClipboardMimeType, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function runtimeClipboardBindingSequence(address: string, capability: string): string {
  return `\u001b]777;vibcodrx;remote-runtime;bind;${address};${capability}\u0007`;
}

export function runtimeClipboardUnbindingSequence(address: string): string {
  return `\u001b]777;vibcodrx;remote-runtime;clear;${address}\u0007`;
}

function isRuntimeClipboardMimeType(value: unknown): value is RuntimeClipboardMimeType {
  return typeof value === "string" && runtimeClipboardMimeTypes.has(value as RuntimeClipboardMimeType);
}

function hasRuntimeClipboardImageSignature(
  bytes: Buffer,
  mimeType: RuntimeClipboardMimeType,
): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function materializeRuntimeClipboardImage(
  directory: string,
  bytes: Buffer,
  mimeType: RuntimeClipboardMimeType,
): Promise<string> {
  if (
    bytes.length === 0 ||
    bytes.length > maximumRuntimeClipboardImageBytes ||
    !hasRuntimeClipboardImageSignature(bytes, mimeType)
  ) throw new Error("Clipboard image signature is invalid");
  const path = join(
    directory,
    `clipboard-${randomUUID()}.${runtimeClipboardExtensions[mimeType]}`,
  );
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}

export const runtimeMcpEnvironmentVariables = [
  "VIBCODRX_RUNTIME_ADDRESS",
  "VIBCODRX_RUNTIME_CAPABILITY",
  "VIBCODRX_RUNTIME_WORKSPACE_ID",
  "VIBCODRX_RUNTIME_WORKSPACE_NAME",
] as const;

export function appServerArguments(endpoint: string): string[] {
  return [
    "app-server",
    "--disable",
    "apps",
    "--listen",
    endpoint,
    "-c",
    `mcp_servers.vibcodrx.env_vars=${JSON.stringify(runtimeMcpEnvironmentVariables)}`,
  ];
}

export function appServerGuardArguments(endpoint: string): string[] {
  return [
    fileURLToPath(new URL("./app-server-guard.js", import.meta.url)),
    "--",
    "codex",
    ...appServerArguments(endpoint),
  ];
}

export function threadSummaryRequest(threadId: string): {
  threadId: string;
  includeTurns: false;
} {
  return { threadId, includeTurns: false };
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function rpcIdKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" || id === null
    ? `${typeof id}:${String(id)}`
    : null;
}

function toPresence(status: ThreadStatus): RuntimePresence {
  if (status.type === "idle") return "idle";
  if (status.type !== "active") return "offline";
  return status.activeFlags.length > 0 ? "waiting-user" : "running";
}

function runtimeAddress(): string {
  return `terminal-${randomBytes(9).toString("base64url")}`;
}

function runtimeCapability(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeAlias(value: string): string {
  const alias = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return alias || "remote-codex";
}

async function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Não foi possível reservar uma porta loopback."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForAppServer(url: string, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error("O Codex App Server encerrou durante o startup.");
    }
    try {
      const response = await fetch(`${url.replace("ws://", "http://")}/readyz`);
      if (response.ok) return;
    } catch {
      // The listener is expected to refuse connections during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("O Codex App Server não ficou pronto a tempo.");
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", handleExit);
      child.off("error", handleExit);
      resolve(exited);
    };
    const handleExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMilliseconds);
    child.once("exit", handleExit);
    child.once("error", handleExit);
    if (childHasExited(child)) finish(true);
  });
}

function linuxProcessSessionId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const sessionId = Number(stat.slice(commandEnd + 2).trim().split(/\s+/)[3]);
    return Number.isSafeInteger(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function signalLinuxProcessSession(sessionId: number, signal: NodeJS.Signals): void {
  if (process.platform !== "linux") return;
  let processIds: number[];
  try {
    processIds = readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return;
  }
  for (const pid of processIds) {
    if (linuxProcessSessionId(pid) !== sessionId) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the identity check and the signal.
    }
  }
}

class AppServerAdapter {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private socket: WebSocket | null = null;

  constructor(private readonly endpoint: string) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout ao conectar ao Codex App Server.")), 5_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Não foi possível conectar ao Codex App Server."));
      });
    });
    socket.on("message", (data) => this.handleMessage(rawDataToString(data)));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("A conexão com o Codex App Server foi encerrada."));
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "vibcodrx_cli",
        title: "Vibcodrx CLI",
        version: packageVersion,
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex App Server indisponível."));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout no Codex App Server: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private handleMessage(payload: string): void {
    let message: unknown;
    try {
      message = JSON.parse(payload) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(new Error(String(message.error.message ?? "Erro do Codex App Server.")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined) {
      this.socket?.send(JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "Unsupported observer request" },
      }));
    }
  }
}

async function resolveWorkspace(session: StoredSession, cwd: string): Promise<WorkspaceContext> {
  const fallback = { name: basename(cwd) || hostname() || "Host remoto" };
  try {
    const project = await getProjectIdentity(cwd);
    const result = await sessionApiRequest<JsonObject>(session, "/v1/projects/resolve", {
      method: "POST",
      body: JSON.stringify(project),
    });
    if (!isRecord(result.match)) return fallback;
    const workspaceId = result.match.workspaceId;
    const workspaceName = result.match.workspaceName;
    if (typeof workspaceId !== "string" || typeof workspaceName !== "string") return fallback;
    return { id: workspaceId, name: workspaceName };
  } catch {
    return fallback;
  }
}

class RuntimeBridge {
  private activeTurnId: string | null = null;
  private brokerSocket: WebSocket | null = null;
  private brokerReconnectTimer: NodeJS.Timeout | null = null;
  private brokerReconnectAttempt = 0;
  private stopped = false;
  private threadId: string | null = null;
  private presence: RuntimePresence = "offline";
  private published = false;
  private clipboardBindingAnnounced = false;
  private clipboardDirectory: string | null = null;
  private clipboardDirectoryPromise: Promise<string> | null = null;
  private readonly incomingClipboardTransfers = new Map<string, IncomingClipboardTransfer>();

  constructor(
    private readonly session: StoredSession,
    private readonly adapter: AppServerAdapter,
    private readonly workspace: WorkspaceContext,
    private readonly cwd: string,
    readonly address: string,
    readonly capability: string,
    private readonly clipboardCapability: string,
  ) {}

  environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      VIBCODRX_RUNTIME_ADDRESS: this.address,
      VIBCODRX_RUNTIME_CAPABILITY: this.capability,
      VIBCODRX_RUNTIME_WORKSPACE_NAME: this.workspace.name,
      ...(this.workspace.id ? { VIBCODRX_RUNTIME_WORKSPACE_ID: this.workspace.id } : {}),
    };
  }

  start(): void {
    this.connectBroker();
  }

  stop(): void {
    this.stopped = true;
    this.unannounceClipboardBinding();
    for (const transfer of this.incomingClipboardTransfers.values()) clearTimeout(transfer.timer);
    this.incomingClipboardTransfers.clear();
    if (this.clipboardDirectory) {
      try {
        rmSync(this.clipboardDirectory, { recursive: true, force: true });
      } catch {
        // Cleanup remains best-effort during process shutdown.
      }
      this.clipboardDirectory = null;
    }
    if (this.brokerReconnectTimer) clearTimeout(this.brokerReconnectTimer);
    this.brokerReconnectTimer = null;
    const socket = this.brokerSocket;
    this.brokerSocket = null;
    if (socket?.readyState === WebSocket.OPEN) {
      if (this.threadId) {
        socket.send(JSON.stringify({
          type: "unregister",
          address: this.address,
          capability: this.capability,
        }));
      }
      socket.close(1000, "Codex runtime ended");
    } else {
      socket?.terminate();
    }
  }

  bindThread(threadId: string): void {
    this.threadId = threadId;
    this.setPresence("idle");
  }

  handleNotification(method: string, params: unknown): void {
    if (!this.threadId || !isRecord(params) || params.threadId !== this.threadId) return;
    if (method === "thread/status/changed" && isRecord(params.status)) {
      this.setPresence(toPresence(params.status as ThreadStatus));
      if (this.presence === "idle" || this.presence === "offline") this.activeTurnId = null;
    } else if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      this.activeTurnId = params.turn.id;
      this.setPresence("running");
    } else if (method === "turn/completed") {
      this.activeTurnId = null;
      this.setPresence("idle");
    } else if (method === "thread/closed") {
      this.activeTurnId = null;
      this.setPresence("offline");
    }
  }

  private participant(): JsonObject {
    const host = hostname().slice(0, 60) || "host-remoto";
    const project = basename(this.cwd).slice(0, 60) || this.workspace.name;
    const title = `Codex · ${host}`.slice(0, 120);
    return {
      address: this.address,
      capability: this.capability,
      clipboardCapability: this.clipboardCapability,
      alias: normalizeAlias(`${host}-${project}`),
      title,
      description: `${title} — ${this.workspace.name}`.slice(0, 160),
      status: this.presence,
      workspace: {
        name: this.workspace.name,
        ...(this.workspace.id ? { id: this.workspace.id } : {}),
      },
    };
  }

  private setPresence(presence: RuntimePresence): void {
    this.presence = presence;
    this.publish();
  }

  private publish(): void {
    const socket = this.brokerSocket;
    if (!this.threadId || socket?.readyState !== WebSocket.OPEN) return;
    if (this.presence === "offline") {
      this.unannounceClipboardBinding();
      if (this.published) {
        socket.send(JSON.stringify({
          type: "unregister",
          address: this.address,
          capability: this.capability,
        }));
        this.published = false;
      }
      return;
    }
    socket.send(JSON.stringify({ type: "register", participant: this.participant() }));
    this.published = true;
  }

  private connectBroker(): void {
    if (this.stopped || this.brokerSocket) return;
    const endpoint = new URL("/v1/runtime/live", this.session.apiUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint, {
      handshakeTimeout: 10_000,
      headers: {
        Authorization: `Bearer ${this.session.accessToken}`,
        "X-Vibcodrx-Device-Id": this.session.device.id,
      },
    });
    this.brokerSocket = socket;
    socket.on("open", () => {
      if (this.brokerSocket !== socket) return;
      this.brokerReconnectAttempt = 0;
      this.published = false;
      this.publish();
    });
    socket.on("message", (data) => void this.handleBrokerMessage(socket, data));
    socket.on("error", () => {
      // The close handler reconnects while the TUI is alive.
    });
    socket.on("close", () => {
      if (this.brokerSocket === socket) {
        this.brokerSocket = null;
        this.published = false;
      }
      this.unannounceClipboardBinding();
      this.scheduleBrokerReconnect();
    });
  }

  private scheduleBrokerReconnect(): void {
    if (this.stopped || this.brokerReconnectTimer) return;
    const base = Math.min(30_000, 1_000 * (2 ** this.brokerReconnectAttempt));
    this.brokerReconnectAttempt = Math.min(this.brokerReconnectAttempt + 1, 5);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.brokerReconnectTimer = setTimeout(() => {
      this.brokerReconnectTimer = null;
      this.connectBroker();
    }, delay);
    this.brokerReconnectTimer.unref();
  }

  private async handleBrokerMessage(socket: WebSocket, data: RawData): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(rawDataToString(data)) as unknown;
    } catch {
      socket.close(1003, "Invalid runtime message");
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === "registered" && event.address === this.address) {
      this.announceClipboardBinding();
      return;
    }
    if (event.target !== this.address) return;
    if (event.type === "clipboard_start") {
      this.handleClipboardStart(socket, event);
      return;
    }
    if (event.type === "clipboard_chunk") {
      this.handleClipboardChunk(socket, event);
      return;
    }
    if (event.type === "clipboard_end") {
      await this.handleClipboardEnd(socket, event);
      return;
    }
    if (event.type !== "deliver") return;
    if (!isRecord(event.message)) return;
    const message = event.message;
    if (
      typeof message.id !== "string" ||
      typeof message.content !== "string" ||
      !isRecord(message.sender) ||
      typeof message.sender.address !== "string" ||
      typeof message.sender.alias !== "string" ||
      !isRecord(message.sender.workspace) ||
      typeof message.sender.workspace.name !== "string"
    ) return;
    try {
      await this.deliver({
        id: message.id,
        content: message.content,
        senderAddress: message.sender.address,
        senderAlias: message.sender.alias,
        senderWorkspaceName: message.sender.workspace.name,
      });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "delivery_ack", messageId: message.id, delivered: true }));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "delivery_ack",
          messageId: message.id,
          delivered: false,
          error: error instanceof Error ? error.message.slice(0, 500) : "Delivery failed",
        }));
      }
    }
  }

  private announceClipboardBinding(): void {
    if (this.clipboardBindingAnnounced || !this.threadId || this.presence === "offline") return;
    process.stdout.write(runtimeClipboardBindingSequence(this.address, this.clipboardCapability));
    this.clipboardBindingAnnounced = true;
  }

  private unannounceClipboardBinding(): void {
    if (!this.clipboardBindingAnnounced) return;
    process.stdout.write(runtimeClipboardUnbindingSequence(this.address));
    this.clipboardBindingAnnounced = false;
  }

  private sendClipboardAcknowledgement(
    socket: WebSocket,
    transferId: string,
    delivered: boolean,
    value?: { path?: string; error?: string },
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "clipboard_ack",
      transferId,
      delivered,
      ...(value?.path ? { path: value.path } : {}),
      ...(value?.error ? { error: value.error.slice(0, 500) } : {}),
    }));
  }

  private rejectClipboardTransfer(socket: WebSocket, transferId: string, error: string): void {
    const transfer = this.incomingClipboardTransfers.get(transferId);
    if (transfer) clearTimeout(transfer.timer);
    this.incomingClipboardTransfers.delete(transferId);
    this.sendClipboardAcknowledgement(socket, transferId, false, { error });
  }

  private handleClipboardStart(socket: WebSocket, event: JsonObject): void {
    if (!isRecord(event.transfer)) return;
    const transfer = event.transfer;
    if (
      typeof transfer.id !== "string" ||
      !runtimeClipboardTransferIdPattern.test(transfer.id) ||
      !isRuntimeClipboardMimeType(transfer.mimeType) ||
      typeof transfer.size !== "number" ||
      !Number.isSafeInteger(transfer.size) ||
      transfer.size <= 0 ||
      transfer.size > maximumRuntimeClipboardImageBytes ||
      typeof transfer.chunkCount !== "number" ||
      !Number.isSafeInteger(transfer.chunkCount) ||
      transfer.chunkCount <= 0 ||
      transfer.chunkCount > 4_096 ||
      this.incomingClipboardTransfers.size >= 4
    ) {
      if (typeof transfer.id === "string" && runtimeClipboardTransferIdPattern.test(transfer.id)) {
        this.sendClipboardAcknowledgement(socket, transfer.id, false, { error: "Invalid clipboard transfer" });
      }
      return;
    }
    if (this.incomingClipboardTransfers.has(transfer.id)) {
      this.rejectClipboardTransfer(socket, transfer.id, "Clipboard transfer replaced");
    }
    const timer = setTimeout(() => {
      this.rejectClipboardTransfer(socket, transfer.id as string, "Clipboard transfer timed out");
    }, 30_000);
    timer.unref();
    this.incomingClipboardTransfers.set(transfer.id, {
      mimeType: transfer.mimeType,
      size: transfer.size,
      chunkCount: transfer.chunkCount,
      chunks: new Array<Buffer | undefined>(transfer.chunkCount),
      receivedBytes: 0,
      timer,
    });
  }

  private handleClipboardChunk(socket: WebSocket, event: JsonObject): void {
    if (
      typeof event.transferId !== "string" ||
      !runtimeClipboardTransferIdPattern.test(event.transferId)
    ) return;
    const transfer = this.incomingClipboardTransfers.get(event.transferId);
    if (!transfer) return;
    if (
      typeof event.index !== "number" ||
      !Number.isSafeInteger(event.index) ||
      event.index < 0 ||
      event.index >= transfer.chunkCount ||
      typeof event.data !== "string" ||
      event.data.length === 0 ||
      event.data.length > maximumRuntimeClipboardChunkCharacters ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(event.data) ||
      transfer.chunks[event.index]
    ) {
      this.rejectClipboardTransfer(socket, event.transferId, "Invalid clipboard chunk");
      return;
    }
    const chunk = Buffer.from(event.data, "base64");
    transfer.chunks[event.index] = chunk;
    transfer.receivedBytes += chunk.length;
    if (transfer.receivedBytes > transfer.size) {
      this.rejectClipboardTransfer(socket, event.transferId, "Clipboard transfer exceeds declared size");
    }
  }

  private async handleClipboardEnd(socket: WebSocket, event: JsonObject): Promise<void> {
    if (
      typeof event.transferId !== "string" ||
      !runtimeClipboardTransferIdPattern.test(event.transferId)
    ) return;
    const transferId = event.transferId;
    const transfer = this.incomingClipboardTransfers.get(transferId);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    this.incomingClipboardTransfers.delete(transferId);
    try {
      if (transfer.receivedBytes !== transfer.size || transfer.chunks.some((chunk) => !chunk)) {
        throw new Error("Clipboard transfer is incomplete");
      }
      const bytes = Buffer.concat(transfer.chunks as Buffer[], transfer.size);
      const directory = await this.ensureClipboardDirectory();
      if (this.stopped) throw new Error("Runtime is stopping");
      const path = await materializeRuntimeClipboardImage(directory, bytes, transfer.mimeType);
      this.sendClipboardAcknowledgement(socket, transferId, true, { path });
    } catch (error) {
      this.sendClipboardAcknowledgement(socket, transferId, false, {
        error: error instanceof Error ? error.message : "Clipboard transfer failed",
      });
    }
  }

  private async ensureClipboardDirectory(): Promise<string> {
    if (this.clipboardDirectory) return this.clipboardDirectory;
    if (!this.clipboardDirectoryPromise) {
      this.clipboardDirectoryPromise = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "vibcodrx-clipboard-"));
        await chmod(directory, 0o700);
        if (this.stopped) {
          rmSync(directory, { recursive: true, force: true });
          throw new Error("Runtime is stopping");
        }
        this.clipboardDirectory = directory;
        return directory;
      })();
    }
    try {
      return await this.clipboardDirectoryPromise;
    } finally {
      this.clipboardDirectoryPromise = null;
    }
  }

  private async refreshThread(): Promise<void> {
    if (!this.threadId) throw new Error("A sessão Codex ainda não possui thread.");
    const result = await this.adapter.request("thread/read", threadSummaryRequest(this.threadId));
    if (!isRecord(result) || !isRecord(result.thread)) throw new Error("Estado inválido da thread Codex.");
    const thread = result.thread;
    if (isRecord(thread.status)) {
      const presence = toPresence(thread.status as ThreadStatus);
      if (presence === "idle" || presence === "offline") this.activeTurnId = null;
      this.setPresence(presence);
    }
  }

  private async deliver(message: {
    id: string;
    content: string;
    senderAddress: string;
    senderAlias: string;
    senderWorkspaceName: string;
  }): Promise<void> {
    await this.refreshThread();
    if (!this.threadId || this.presence === "offline") throw new Error("Recipient is unavailable");
    const envelope = [
      `[Mensagem recebida de ${message.senderAlias} — Workspace: ${message.senderWorkspaceName}]`,
      `Endereço do remetente: ${message.senderAddress}`,
      `ID: ${message.id}`,
      "",
      `Conteúdo: ${message.content}`,
    ].join("\n");
    if (this.presence === "idle") {
      await this.adapter.request("turn/start", {
        threadId: this.threadId,
        clientUserMessageId: message.id,
        input: [{ type: "text", text: envelope, text_elements: [] }],
        cwd: this.cwd,
      });
    } else {
      if (!this.activeTurnId) throw new Error("Recipient active turn is unavailable");
      await this.adapter.request("turn/steer", {
        threadId: this.threadId,
        clientUserMessageId: message.id,
        input: [{ type: "text", text: envelope, text_elements: [] }],
        expectedTurnId: this.activeTurnId,
      });
    }
    this.setPresence("running");
  }
}

function shouldManageCodex(args: string[]): boolean {
  const first = args[0];
  return first === undefined || first === "resume" || first === "fork";
}

async function runRealCodex(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function runManagedCodex(args: string[]): Promise<void> {
  if (!shouldManageCodex(args)) {
    process.exitCode = await runRealCodex(args);
    return;
  }
  const session = await loadSession();
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    process.stderr.write("Vibcodrx: sessão ausente ou expirada; iniciando Codex sem runtime distribuído.\n");
    process.exitCode = await runRealCodex(args);
    return;
  }

  const cwd = process.cwd();
  const workspace = await resolveWorkspace(session, cwd);
  const address = runtimeAddress();
  const capability = runtimeCapability();
  const clipboardCapability = runtimeCapability();
  const appServerPort = await getFreeLoopbackPort();
  const appServerUrl = `ws://127.0.0.1:${appServerPort}`;
  const adapter = new AppServerAdapter(appServerUrl);
  let bridge: RuntimeBridge | null = null;
  const appServer = spawn(process.execPath, appServerGuardArguments(appServerUrl), {
    cwd,
    env: {
      ...process.env,
      VIBCODRX_RUNTIME_ADDRESS: address,
      VIBCODRX_RUNTIME_CAPABILITY: capability,
      VIBCODRX_RUNTIME_WORKSPACE_NAME: workspace.name,
      ...(workspace.id ? { VIBCODRX_RUNTIME_WORKSPACE_ID: workspace.id } : {}),
    },
    stdio: ["pipe", "ignore", "ignore"],
    detached: process.platform !== "win32",
  });
  const appServerSessionId = appServer.pid;
  const killAppServer = (signal: NodeJS.Signals): void => {
    if (childHasExited(appServer)) return;
    try {
      appServer.kill(signal);
    } catch {
      // The guard may have exited between the state check and the signal.
    }
  };
  const forceAppServerSession = (): void => {
    if (appServerSessionId !== undefined) {
      signalLinuxProcessSession(appServerSessionId, "SIGKILL");
    }
    killAppServer("SIGKILL");
  };
  const stopAppServer = async (): Promise<void> => {
    if (childHasExited(appServer)) return;
    appServer.stdin?.end();
    if (await waitForChildExit(appServer, 1_500)) return;
    killAppServer("SIGTERM");
    if (await waitForChildExit(appServer, 1_000)) return;
    forceAppServerSession();
    await waitForChildExit(appServer, 500);
  };

  let proxyServer: WebSocketServer | null = null;
  let tui: ChildProcess | null = null;
  const appServerSpawned = new Promise<void>((resolve, reject) => {
    appServer.once("spawn", resolve);
    appServer.once("error", () => reject(new Error("Não foi possível iniciar o Codex App Server.")));
  });
  appServer.once("exit", () => {
    if (appServerSessionId !== undefined) {
      signalLinuxProcessSession(appServerSessionId, "SIGKILL");
    }
  });
  const swallowSigint = (): void => undefined;
  let terminationRequested = false;
  const handleTermination = (signal: NodeJS.Signals): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    if (tui?.exitCode === null) tui.kill(signal);
    killAppServer(signal);
  };
  process.on("SIGINT", swallowSigint);
  process.on("SIGTERM", handleTermination);
  process.on("SIGHUP", handleTermination);
  try {
    await appServerSpawned;
    await waitForAppServer(appServerUrl, appServer);
    await adapter.connect();
    bridge = new RuntimeBridge(
      session,
      adapter,
      workspace,
      cwd,
      address,
      capability,
      clipboardCapability,
    );
    bridge.start();
    const proxyPort = await getFreeLoopbackPort();
    proxyServer = new WebSocketServer({ host: "127.0.0.1", port: proxyPort });
    const proxyReady = new Promise<void>((resolve, reject) => {
      proxyServer!.once("listening", resolve);
      proxyServer!.once("error", reject);
    });
    proxyServer.on("connection", (clientSocket) => {
      const upstreamSocket = new WebSocket(appServerUrl);
      const pendingBindings = new Set<string>();
      const pendingFrames: Array<{ data: RawData; isBinary: boolean }> = [];
      const forwardClient = (data: RawData, isBinary: boolean): void => {
        if (!isBinary) {
          try {
            const message = JSON.parse(rawDataToString(data)) as unknown;
            if (isRecord(message)) {
              const key = rpcIdKey(message.id);
              if (
                key &&
                (message.method === "thread/start" || message.method === "thread/resume" || message.method === "thread/fork")
              ) pendingBindings.add(key);
            }
          } catch {
            // Invalid frames remain the App Server's responsibility.
          }
        }
        upstreamSocket.send(data, { binary: isBinary });
      };
      clientSocket.on("message", (data, isBinary) => {
        if (upstreamSocket.readyState === WebSocket.OPEN) forwardClient(data, isBinary);
        else if (upstreamSocket.readyState === WebSocket.CONNECTING) pendingFrames.push({ data, isBinary });
      });
      upstreamSocket.on("open", () => {
        for (const frame of pendingFrames.splice(0)) forwardClient(frame.data, frame.isBinary);
      });
      upstreamSocket.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const message = JSON.parse(rawDataToString(data)) as unknown;
            if (isRecord(message)) {
              const key = rpcIdKey(message.id);
              if (message.method === undefined && key && pendingBindings.delete(key)) {
                if (isRecord(message.result) && isRecord(message.result.thread) && typeof message.result.thread.id === "string") {
                  bridge?.bindThread(message.result.thread.id);
                }
              }
              if (typeof message.method === "string" && message.id === undefined) {
                bridge?.handleNotification(message.method, message.params);
              }
            }
          } catch {
            // The TUI receives the original frame.
          }
        }
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
      });
      clientSocket.on("close", () => upstreamSocket.close());
      clientSocket.on("error", () => upstreamSocket.terminate());
      upstreamSocket.on("close", () => clientSocket.close());
      upstreamSocket.on("error", () => clientSocket.close(1011, "Codex App Server unavailable"));
    });
    await proxyReady;

    tui = spawn("codex", ["--remote", `ws://127.0.0.1:${proxyPort}`, ...args], {
      cwd,
      env: bridge.environment(),
      stdio: "inherit",
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      tui!.once("error", reject);
      tui!.once("exit", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    process.off("SIGINT", swallowSigint);
    process.off("SIGTERM", handleTermination);
    process.off("SIGHUP", handleTermination);
    bridge?.stop();
    proxyServer?.close();
    adapter.close();
    if (tui?.exitCode === null) tui.kill("SIGTERM");
    await stopAppServer();
  }
}
