import type { FastifyRequest } from "fastify";

const LOCAL_FALLBACK_HOST = "127.0.0.1";

function normalizeHttpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).host;
  } catch {
    return null;
  }
}

export function getRequestProtocol(req: FastifyRequest): "http" | "https" {
  const xfProto = req.headers["x-forwarded-proto"];
  if (typeof xfProto === "string") {
    const proto = xfProto.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") return "https";
  }
  return "http";
}

export function getPublicOrigin(req: FastifyRequest): string {
  const configured = normalizeHttpOrigin(process.env.APP_BASE_URL);
  if (configured) return configured;

  const host = normalizeHostHeader(typeof req.headers.host === "string" ? req.headers.host.trim() : undefined);
  if (host) return `${getRequestProtocol(req)}://${host}`;

  const port = process.env.PORT && process.env.PORT !== "80" ? `:${process.env.PORT}` : "";
  return `http://${LOCAL_FALLBACK_HOST}${port}`;
}

export function normalizeAppPath(path: string | undefined, fallback: string): string {
  if (typeof path !== "string" || path.length === 0) return fallback;
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;
  return path;
}

export function buildAppUrl(req: FastifyRequest, path: string): string {
  return new URL(normalizeAppPath(path, "/"), `${getPublicOrigin(req)}/`).toString();
}
