import { clearSession, loadSession, type StoredSession } from "./config.js";
import {
  configureCodexMcp,
  ensureCodexInstalled,
  getCodexMcpEntry,
  getCodexVersion,
} from "./codex.js";
import { normalizeApiUrl, sessionApiRequest, validateSession } from "./api.js";
import { loginWithDeviceFlow } from "./device-auth.js";
import { packageVersion } from "./constants.js";
import { runMcpServer } from "./mcp.js";

function apiUrlArgument(args: string[]): string | undefined {
  const index = args.indexOf("--api-url");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("Informe uma URL depois de --api-url.");
  return value;
}

function commandArguments(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--api-url") {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

async function currentIdentity(session: StoredSession): Promise<{
  user: { name: string; email: string };
  tenant: { id: string; name: string };
}> {
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error("A sessão Vibcodrx expirou.");
  }
  return validateSession(session);
}

async function login(args: string[]): Promise<StoredSession> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("O login inicial exige um terminal interativo para concluir a autorização no navegador.");
  }
  const session = await loginWithDeviceFlow(normalizeApiUrl(apiUrlArgument(args)));
  const identity = await currentIdentity(session);
  process.stdout.write(`Autenticado como ${identity.user.name} (${identity.user.email}).\n`);
  return session;
}

async function ensureAuthenticated(args: string[]): Promise<StoredSession> {
  const existing = await loadSession();
  if (existing) {
    try {
      const identity = await currentIdentity(existing);
      process.stdout.write(`2/3 Conta: ${identity.user.name} · autenticada\n`);
      return existing;
    } catch {
      process.stdout.write("2/3 Conta: sessão ausente ou expirada; nova autorização necessária.\n");
    }
  } else {
    process.stdout.write("2/3 Conta: autorização necessária.\n");
  }
  return login(args);
}

async function wizard(args: string[]): Promise<void> {
  process.stdout.write("Vibcodrx · preparar este host\n\n");
  const codexVersion = await ensureCodexInstalled();
  process.stdout.write(`1/3 Codex: ${codexVersion}\n`);
  await ensureAuthenticated(args);
  const mcp = await configureCodexMcp();
  process.stdout.write(`3/3 MCP: ${mcp === "configured" ? "configurado" : "já estava correto"}\n\n`);
  process.stdout.write("Pronto. A partir de agora, execute apenas `codex` neste host.\n");
}

async function status(): Promise<void> {
  const session = await loadSession();
  const codexVersion = await getCodexVersion();
  const mcp = codexVersion ? await getCodexMcpEntry() : null;
  process.stdout.write(`Codex: ${codexVersion || "não encontrado"}\n`);
  process.stdout.write(
    `MCP Vibcodrx: ${mcp ? "configurado" : "não configurado"}\n`,
  );
  if (!session) {
    process.stdout.write("Conta: não autenticada\n");
    return;
  }
  try {
    const identity = await currentIdentity(session);
    process.stdout.write(`Conta: ${identity.user.name} (${identity.user.email})\n`);
    process.stdout.write(`API: ${session.apiUrl}\n`);
  } catch (error) {
    process.stdout.write(`Conta: sessão inválida · ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function doctor(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? "✓" : "✗"} ${label}: ${detail}\n`);
  };

  check("Node.js", Number(process.versions.node.split(".")[0]) >= 22, process.version);
  const codexVersion = await getCodexVersion();
  check("Codex", Boolean(codexVersion), codexVersion || "não encontrado");
  const entry = codexVersion ? await getCodexMcpEntry() : null;
  const expectedMcp =
    entry?.transport?.type === "stdio" &&
    entry.transport.command === "vibcodrx" &&
    Array.isArray(entry.transport.args) &&
    entry.transport.args[0] === "mcp";
  check("MCP", expectedMcp, expectedMcp ? "vibcodrx mcp" : "ausente ou divergente");

  const session = await loadSession();
  if (!session) {
    check("Autenticação", false, "execute `vibcodrx login`");
  } else {
    try {
      const identity = await currentIdentity(session);
      check("Autenticação", true, `${identity.user.email} · ${session.apiUrl}`);
      await sessionApiRequest(session, "/v1/mcp/inventory");
      check("Protocolo MCP", true, "inventário remoto acessível");
    } catch (error) {
      check("Autenticação", false, error instanceof Error ? error.message : String(error));
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} verificação(ões) precisam de atenção.`);
  }
}

async function logout(): Promise<void> {
  const session = await loadSession();
  let remoteRevoked = true;
  if (session) {
    try {
      await sessionApiRequest(session, "/api/auth/sign-out", { method: "POST" });
    } catch {
      remoteRevoked = false;
    }
  }
  await clearSession();
  process.stdout.write(
    remoteRevoked
      ? "Sessão Vibcodrx encerrada neste host.\n"
      : "Credencial local removida. A API estava indisponível e a sessão remota expirará pelo servidor.\n",
  );
}

function help(): void {
  process.stdout.write(`Vibcodrx CLI ${packageVersion}

Uso:
  vibcodrx                 prepara Codex, autenticação e MCP em um único fluxo
  vibcodrx login           autentica este host
  vibcodrx logout          encerra a sessão deste host
  vibcodrx status          mostra o estado atual
  vibcodrx doctor          valida Codex, MCP, conta e API
  vibcodrx mcp             inicia o servidor MCP stdio (usado pelo Codex)

Opções:
  --api-url <url>          usa outra API; HTTP é aceito somente em localhost
  --version                mostra a versão
  --help                   mostra esta ajuda
`);
}

export async function runCli(args: string[]): Promise<void> {
  apiUrlArgument(args);
  const [command] = commandArguments(args);
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    help();
    return;
  }
  if (!command || command === "setup") {
    await wizard(args);
    return;
  }
  if (command === "login") {
    await login(args);
    return;
  }
  if (command === "logout") {
    await logout();
    return;
  }
  if (command === "status") {
    await status();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  throw new Error(`Comando desconhecido: ${command}. Use \`vibcodrx --help\`.`);
}
