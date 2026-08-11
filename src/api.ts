import { z } from "zod";

import { defaultApiUrl, protocolVersion } from "./constants.js";
import type { StoredSession } from "./config.js";

const apiErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({ code: z.string().optional(), message: z.string().optional() }),
  ]).optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export class ApiRequestError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeApiUrl(value: string | undefined): string {
  const url = new URL(value || process.env.VIBCODRX_API_URL || defaultApiUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("A API Vibcodrx precisa usar HTTPS; HTTP é aceito somente em localhost.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    const parsedData = parsed.success ? parsed.data : null;
    const nested = parsedData && typeof parsedData.error === "object"
      ? parsedData.error
      : null;
    const message = parsedData
      ? parsedData.error_description ||
        parsedData.message ||
        nested?.message ||
        (typeof parsedData.error === "string" ? parsedData.error : undefined)
      : undefined;
    throw new ApiRequestError(
      response.status,
      message || `A API Vibcodrx respondeu com HTTP ${response.status}.`,
      nested?.code ?? (typeof parsedData?.error === "string" ? parsedData.error : null),
    );
  }
  return body as T;
}

export async function publicApiRequest<T>(
  apiUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${normalizeApiUrl(apiUrl)}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Vibcodrx-Protocol-Version": protocolVersion,
        ...init.headers,
      },
      signal: controller.signal,
    });
    return parseResponse<T>(response);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A API Vibcodrx não respondeu dentro do tempo limite.");
    }
    throw new Error(
      `Não foi possível alcançar a API Vibcodrx: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function sessionApiRequest<T>(
  session: StoredSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return publicApiRequest<T>(session.apiUrl, path, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Vibcodrx-Device-Id": session.device.id,
      ...init.headers,
    },
  });
}

export async function validateSession(session: StoredSession): Promise<{
  user: { name: string; email: string };
  tenant: { id: string; name: string };
}> {
  return sessionApiRequest(session, "/v1/me");
}
