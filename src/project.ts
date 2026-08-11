import { createHash } from "node:crypto";
import { basename } from "node:path";

import { runCommand } from "./process.js";

export type ProjectIdentity = {
  fingerprint: string;
  fingerprintVersion: 1;
  label: string;
};

export function sanitizeRemoteUrl(value: string): string | null {
  const remote = value.trim();
  if (!remote) return null;
  const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(remote);
  if (scp && !remote.includes("://")) {
    const host = scp[1]?.toLowerCase();
    const path = scp[2]?.replace(/^\/+/, "").replace(/\.git$/, "");
    return host && path ? `ssh://${host}/${path}` : null;
  }
  try {
    const url = new URL(remote);
    if (!url.hostname) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

export async function getProjectIdentity(cwd = process.cwd()): Promise<ProjectIdentity> {
  const rootResult = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5_000,
  }).catch(() => null);
  const root = rootResult?.exitCode === 0 ? rootResult.stdout.trim() : cwd;
  const remoteResult = await runCommand(
    "git",
    ["-C", root, "config", "--get", "remote.origin.url"],
    { timeoutMs: 5_000 },
  ).catch(() => null);
  const sanitizedRemote = remoteResult?.exitCode === 0
    ? sanitizeRemoteUrl(remoteResult.stdout)
    : null;
  const label = basename(root).slice(0, 160) || "Projeto remoto";
  const portableSource = sanitizedRemote || `unbound:${label.toLowerCase()}`;
  return {
    fingerprint: createHash("sha256").update(`v1:${portableSource}`).digest("hex"),
    fingerprintVersion: 1,
    label,
  };
}
