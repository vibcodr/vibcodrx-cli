import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { WebSocket, type RawData } from "ws";

import { sessionApiRequest } from "./api.js";
import { loadSession, type StoredSession } from "./config.js";
import { getProjectIdentity } from "./project.js";

type JsonObject = Record<string, unknown>;

export type RuntimePresence = "idle" | "running" | "waiting-user";

export type RuntimeWorkspace = {
  id?: string;
  name: string;
};

export type RuntimeContext = {
  address: string;
  capability: string;
  workspace: RuntimeWorkspace;
};

export type RuntimeIncomingMessage = {
  id: string;
  content: string;
  replyTo: string | null;
  sender: {
    address: string;
    alias: string;
    workspace: { name: string };
  };
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

type RuntimeWorkspaceResolution = {
  workspace: RuntimeWorkspace;
  projectLabel: string;
};

const maximumRuntimeClipboardImageBytes = 25 * 1_024 * 1_024;
const maximumRuntimeClipboardChunkCharacters = 70_000;
const maximumWorkspaceResolutionRetryDelayMs = 30_000;
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

export function runtimeTerminalBindingSequence(address: string): string {
  return `\u001b]777;vibcodrx;remote-runtime;bind;${address}\u0007`;
}

export function runtimeTerminalUnbindingSequence(address: string): string {
  return `\u001b]777;vibcodrx;remote-runtime;clear;${address}\u0007`;
}

function writeTerminalRuntimeControl(sequence: string): boolean {
  if (process.platform !== "linux") return false;
  let descriptor: number | null = null;
  try {
    descriptor = openSync("/dev/tty", "w");
    return writeSync(descriptor, sequence) === Buffer.byteLength(sequence);
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The binding is best-effort when the controlling TTY is closing.
      }
    }
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function runtimeWorkspaceRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.min(maximumWorkspaceResolutionRetryDelayMs, 1_000 * (2 ** normalizedAttempt));
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
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

async function resolveWorkspace(
  session: StoredSession,
  cwd: string,
  project?: Awaited<ReturnType<typeof getProjectIdentity>>,
): Promise<RuntimeWorkspaceResolution> {
  const resolvedProject = project ?? await getProjectIdentity(cwd);
  const fallback = {
    workspace: { name: resolvedProject.label || basename(cwd) || hostname() || "Host remoto" },
    projectLabel: resolvedProject.label || basename(cwd) || "Projeto remoto",
  };
  try {
    const result = await sessionApiRequest<JsonObject>(session, "/v1/projects/resolve", {
      method: "POST",
      body: JSON.stringify(resolvedProject),
    });
    if (!isRecord(result.match)) return fallback;
    const workspaceId = result.match.workspaceId;
    const workspaceName = result.match.workspaceName;
    if (typeof workspaceId !== "string" || typeof workspaceName !== "string") return fallback;
    return {
      workspace: { id: workspaceId, name: workspaceName },
      projectLabel: resolvedProject.label,
    };
  } catch {
    return fallback;
  }
}

function endpointFor(session: StoredSession): URL {
  const endpoint = new URL("/v1/runtime/live", session.apiUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint;
}

export class RuntimeBridge {
  private brokerSocket: WebSocket | null = null;
  private brokerReconnectTimer: NodeJS.Timeout | null = null;
  private brokerReconnectAttempt = 0;
  private terminalBindingAnnounced = false;
  private stopped = false;
  private presence: RuntimePresence = "idle";
  private clipboardDirectory: string | null = null;
  private clipboardDirectoryPromise: Promise<string> | null = null;
  private readonly incomingClipboardTransfers = new Map<string, IncomingClipboardTransfer>();
  private readonly incomingMessages: RuntimeIncomingMessage[] = [];

  readonly address: string;
  readonly capability: string;
  readonly projectLabel: string;

  private readonly clipboardCapability: string;
  private currentWorkspace: RuntimeWorkspace;

  constructor(
    private readonly session: StoredSession,
    resolution: RuntimeWorkspaceResolution,
  ) {
    this.address = runtimeAddress();
    this.capability = runtimeCapability();
    this.clipboardCapability = runtimeCapability();
    this.currentWorkspace = resolution.workspace;
    this.projectLabel = resolution.projectLabel;
  }

  get workspace(): RuntimeWorkspace {
    return this.currentWorkspace;
  }

  get context(): RuntimeContext {
    return {
      address: this.address,
      capability: this.capability,
      workspace: this.workspace,
    };
  }

  updateWorkspace(workspace: RuntimeWorkspace): void {
    this.currentWorkspace = workspace;
    const socket = this.brokerSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "update",
        address: this.address,
        capability: this.capability,
        workspace,
      }));
    }
  }

  start(): void {
    this.announceTerminalBinding();
    this.connectBroker();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTerminalBinding();
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
      socket.send(JSON.stringify({
        type: "unregister",
        address: this.address,
        capability: this.capability,
      }));
      socket.close(1000, "MCP runtime ended");
    } else {
      socket?.terminate();
    }
  }

  drainIncomingMessages(): RuntimeIncomingMessage[] {
    return this.incomingMessages.splice(0, this.incomingMessages.length);
  }

  setPresence(presence: RuntimePresence): void {
    this.presence = presence;
    const socket = this.brokerSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "update",
        address: this.address,
        capability: this.capability,
        status: presence,
      }));
    }
  }

  private participant(): JsonObject {
    const host = hostname().slice(0, 120) || "host-remoto";
    const title = `Codex · ${host}`.slice(0, 120);
    return {
      address: this.address,
      capability: this.capability,
      clipboardCapability: this.clipboardCapability,
      kind: "cli",
      alias: normalizeAlias(`${host}-${this.projectLabel}`),
      title,
      description: `${title} — ${this.workspace.name}`.slice(0, 160),
      host,
      project: this.projectLabel,
      status: this.presence,
      workspace: this.workspace,
    };
  }

  private announceTerminalBinding(): void {
    if (this.terminalBindingAnnounced) return;
    this.terminalBindingAnnounced = writeTerminalRuntimeControl(
      runtimeTerminalBindingSequence(this.address),
    );
  }

  private clearTerminalBinding(): void {
    if (!this.terminalBindingAnnounced) return;
    writeTerminalRuntimeControl(runtimeTerminalUnbindingSequence(this.address));
    this.terminalBindingAnnounced = false;
  }

  private connectBroker(): void {
    if (this.stopped || this.brokerSocket) return;
    const socket = new WebSocket(endpointFor(this.session), {
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
      this.announceTerminalBinding();
      socket.send(JSON.stringify({ type: "register", participant: this.participant() }));
    });
    socket.on("message", (data) => void this.handleBrokerMessage(socket, data));
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401) this.stop();
    });
    socket.on("error", () => {
      // The close handler reconnects while the MCP process is alive.
    });
    socket.on("close", () => {
      if (this.brokerSocket === socket) this.brokerSocket = null;
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
    if (!isRecord(event) || event.target !== this.address) return;
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
    if (event.type !== "deliver" || !isRecord(event.message)) return;
    const message = event.message;
    if (
      typeof message.id !== "string" ||
      typeof message.content !== "string" ||
      !(message.replyTo === null || typeof message.replyTo === "string") ||
      !isRecord(message.sender) ||
      typeof message.sender.address !== "string" ||
      typeof message.sender.alias !== "string" ||
      !isRecord(message.sender.workspace) ||
      typeof message.sender.workspace.name !== "string"
    ) return;
    this.incomingMessages.push({
      id: message.id,
      content: message.content,
      replyTo: message.replyTo,
      sender: {
        address: message.sender.address,
        alias: message.sender.alias,
        workspace: { name: message.sender.workspace.name },
      },
    });
    while (this.incomingMessages.length > 100) this.incomingMessages.shift();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "delivery_ack", messageId: message.id, delivered: true }));
    }
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
        this.sendClipboardAcknowledgement(socket, transfer.id, false, {
          error: "Invalid clipboard transfer",
        });
      }
      return;
    }
    if (this.incomingClipboardTransfers.has(transfer.id)) {
      this.rejectClipboardTransfer(socket, transfer.id, "Clipboard transfer replaced");
    }
    const transferId = transfer.id;
    const timer = setTimeout(() => {
      this.rejectClipboardTransfer(socket, transferId, "Clipboard transfer timed out");
    }, 30_000);
    timer.unref();
    this.incomingClipboardTransfers.set(transferId, {
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
}

export type RuntimeState = {
  current: RuntimeBridge | null;
  closed: boolean;
  workspaceResolutionTimer: NodeJS.Timeout | null;
};

function reconcileRuntimeWorkspace(
  session: StoredSession,
  cwd: string,
  initialProject: Awaited<ReturnType<typeof getProjectIdentity>>,
  state: RuntimeState,
  bridge: RuntimeBridge,
): void {
  let attempt = 0;
  let firstAttempt = true;
  let project = initialProject;

  const resolve = async (): Promise<void> => {
    if (
      state.closed ||
      state.current !== bridge ||
      Date.parse(session.expiresAt) <= Date.now()
    ) return;

    if (!firstAttempt) {
      project = await getProjectIdentity(cwd).catch(() => project);
      if (state.closed || state.current !== bridge) return;
    }
    firstAttempt = false;
    const resolution = await resolveWorkspace(session, cwd, project).catch(() => null);
    if (state.closed || state.current !== bridge) return;

    if (resolution) {
      bridge.updateWorkspace(resolution.workspace);
      if (resolution.workspace.id) return;
    }

    const retryTimer = setTimeout(() => {
      if (state.workspaceResolutionTimer === retryTimer) {
        state.workspaceResolutionTimer = null;
      }
      void resolve();
    }, runtimeWorkspaceRetryDelayMs(attempt));
    attempt += 1;
    retryTimer.unref();
    state.workspaceResolutionTimer = retryTimer;
  };

  void resolve();
}

export async function startMcpRuntime(cwd: string, state: RuntimeState): Promise<void> {
  if (state.closed) return;
  const session = await loadSession();
  if (state.closed || !session || Date.parse(session.expiresAt) <= Date.now()) return;
  const project = await getProjectIdentity(cwd);
  if (state.closed) return;
  const fallback: RuntimeWorkspaceResolution = {
    workspace: { name: project.label || basename(cwd) || hostname() || "Host remoto" },
    projectLabel: project.label || basename(cwd) || "Projeto remoto",
  };
  const bridge = new RuntimeBridge(session, fallback);
  state.current = bridge;
  bridge.start();
  reconcileRuntimeWorkspace(session, cwd, project, state, bridge);
}

export function stopMcpRuntime(state: RuntimeState): void {
  state.closed = true;
  if (state.workspaceResolutionTimer) clearTimeout(state.workspaceResolutionTimer);
  state.workspaceResolutionTimer = null;
  state.current?.stop();
  state.current = null;
}
