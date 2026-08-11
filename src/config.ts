import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { commandExists, runCommand } from "./process.js";

const sessionSchema = z
  .object({
    version: z.literal(1),
    apiUrl: z.url(),
    accessToken: z.string().min(16),
    expiresAt: z.string().datetime(),
    device: z.object({
      id: z.string().min(8).max(128),
      name: z.string().min(1).max(120),
      installationHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  })
  .strict();

const installationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(8).max(128),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type StoredSession = z.infer<typeof sessionSchema>;
export type Installation = z.infer<typeof installationSchema>;

function configDirectory(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "vibcodrx");
}

function credentialsPath(): string {
  return join(configDirectory(), "credentials.json");
}

function installationPath(): string {
  return join(configDirectory(), "installation.json");
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await chmod(configDirectory(), 0o700);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readLinuxKeyring(): Promise<StoredSession | null> {
  if (platform() !== "linux" || !(await commandExists("secret-tool"))) return null;
  try {
    const result = await runCommand(
      "secret-tool",
      ["lookup", "service", "vibcodrx", "account", "cli-session"],
      { timeoutMs: 3_000 },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    return sessionSchema.parse(JSON.parse(result.stdout) as unknown);
  } catch {
    return null;
  }
}

async function writeLinuxKeyring(session: StoredSession): Promise<boolean> {
  if (platform() !== "linux" || !(await commandExists("secret-tool"))) return false;
  try {
    const result = await runCommand(
      "secret-tool",
      [
        "store",
        "--label=Vibcodrx CLI",
        "service",
        "vibcodrx",
        "account",
        "cli-session",
      ],
      { input: JSON.stringify(session), timeoutMs: 3_000 },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function clearLinuxKeyring(): Promise<void> {
  if (platform() !== "linux" || !(await commandExists("secret-tool"))) return;
  await runCommand(
    "secret-tool",
    ["clear", "service", "vibcodrx", "account", "cli-session"],
    { timeoutMs: 3_000 },
  ).catch(() => undefined);
}

export async function getInstallation(): Promise<Installation> {
  const existing = installationSchema.safeParse(await readJson(installationPath()));
  if (existing.success) return existing.data;
  const seed = `${randomUUID()}:${randomUUID()}`;
  const installation: Installation = {
    version: 1,
    id: `device-${randomUUID()}`,
    hash: createHash("sha256").update(seed).digest("hex"),
  };
  await writePrivateJson(installationPath(), installation);
  return installation;
}

export function getDeviceName(): string {
  return `CLI · ${hostname().slice(0, 100) || "host remoto"}`;
}

export async function loadSession(): Promise<StoredSession | null> {
  const keyringSession = await readLinuxKeyring();
  if (keyringSession) return keyringSession;
  const fileSession = sessionSchema.safeParse(await readJson(credentialsPath()));
  return fileSession.success ? fileSession.data : null;
}

export async function saveSession(session: StoredSession): Promise<"keyring" | "file"> {
  if (await writeLinuxKeyring(session)) {
    await unlink(credentialsPath()).catch(() => undefined);
    return "keyring";
  }
  await writePrivateJson(credentialsPath(), session);
  return "file";
}

export async function clearSession(): Promise<void> {
  await clearLinuxKeyring();
  await unlink(credentialsPath()).catch(() => undefined);
}
