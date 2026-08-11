import { spawn } from "node:child_process";
import { platform } from "node:os";

import { z } from "zod";

import { publicApiRequest } from "./api.js";
import {
  getDeviceName,
  getInstallation,
  saveSession,
  type StoredSession,
} from "./config.js";
import { deviceClientId } from "./constants.js";

const deviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const deviceTokenSchema = z.object({
  access_token: z.string().min(16),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openBrowser(url: string): boolean {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function loginWithDeviceFlow(apiUrl: string): Promise<StoredSession> {
  const deviceCode = deviceCodeSchema.parse(
    await publicApiRequest(apiUrl, "/api/auth/device/code", {
      method: "POST",
      body: JSON.stringify({ client_id: deviceClientId, scope: "mcp" }),
    }),
  );

  process.stdout.write("\nAutorize este host no navegador:\n");
  process.stdout.write(`  Código: ${deviceCode.user_code}\n`);
  process.stdout.write(`  URL: ${deviceCode.verification_uri_complete}\n\n`);
  openBrowser(deviceCode.verification_uri_complete);

  const deadline = Date.now() + deviceCode.expires_in * 1_000;
  let intervalMs = deviceCode.interval * 1_000;
  let token: z.infer<typeof deviceTokenSchema> | null = null;
  while (Date.now() < deadline) {
    await wait(intervalMs);
    try {
      token = deviceTokenSchema.parse(
        await publicApiRequest(apiUrl, "/api/auth/device/token", {
          method: "POST",
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode.device_code,
            client_id: deviceClientId,
          }),
        }),
      );
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as Error & { code?: string | null }).code
        : null;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (code === "access_denied") throw new Error("A autorização deste host foi negada.");
      if (code === "expired_token") break;
      throw error;
    }
  }
  if (!token) throw new Error("O código expirou antes da autorização ser concluída.");

  const installation = await getInstallation();
  const name = getDeviceName();
  const provisional: StoredSession = {
    version: 1,
    apiUrl,
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1_000).toISOString(),
    device: {
      id: installation.id,
      name,
      installationHash: installation.hash,
    },
  };
  await publicApiRequest(apiUrl, "/v1/devices/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${provisional.accessToken}` },
    body: JSON.stringify({
      id: provisional.device.id,
      kind: "cli",
      name: provisional.device.name,
      installationHash: provisional.device.installationHash,
    }),
  });
  await saveSession(provisional);
  return provisional;
}
