import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrisma } from "./db.js";
import { getPublicOrigin } from "./origin.js";

export type AuthUser = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
};

const SESSION_COOKIE = "sid";
const SESSION_TTL_DAYS = 30;

// Allowed hosts for host validation (comma-separated environment variable)
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim().toLowerCase()) || [];

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function getConfiguredAppHostname(): string | null {
  const configured = process.env.APP_BASE_URL;
  if (!configured) return null;
  try {
    return new URL(configured).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function isLocalHostname(hostname: string | null): boolean {
  if (!hostname) return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

/**
 * Validates that the request's Host header is from an allowed domain.
 * Returns true if the host is allowed or if no ALLOWED_HOSTS are configured (development mode).
 */
function isHostAllowed(req: FastifyRequest): boolean {
  const hostHeader = normalizeHostname(typeof req.headers.host === "string" ? req.headers.host : null);
  if (!hostHeader) return false;

  const configuredHost = getConfiguredAppHostname();
  if (configuredHost && hostHeader === configuredHost) return true;
  if (isLocalHostname(hostHeader)) return true;

  // If no allowed hosts are configured, skip validation (development)
  if (ALLOWED_HOSTS.length === 0) return true;

  // Check exact match or wildcard subdomain match
  return ALLOWED_HOSTS.some((allowed) => {
    if (allowed === hostHeader) return true;
    // Allow subdomains of allowed domains (e.g., www.example.com for example.com)
    if (allowed.startsWith("*.") && hostHeader.endsWith(allowed.slice(1))) return true;
    return false;
  });
}

function isProbablySecure(req: FastifyRequest): boolean {
  const xfProto = req.headers["x-forwarded-proto"];
  if (typeof xfProto === "string") return xfProto.split(",")[0].trim() === "https";
  const hostHeader = normalizeHostname(typeof req.headers.host === "string" ? req.headers.host : null);
  if (isLocalHostname(hostHeader)) return false;

  const configuredOrigin = process.env.APP_BASE_URL ? getPublicOrigin(req) : null;
  if (configuredOrigin) {
    try {
      const configured = new URL(configuredOrigin);
      if (!hostHeader || configured.hostname.toLowerCase() === hostHeader) {
        return configured.protocol === "https:";
      }
    } catch (_) {}
  }

  // Local dev usually uses http.
  return false;
}

export async function loadUserFromSession(req: FastifyRequest): Promise<AuthUser | null> {
  req.authSessionLookupError = null;

  // Validate host header to prevent host spoofing attacks
  if (!isHostAllowed(req)) {
    console.warn("[auth] Request from disallowed host:", req.headers.host);
    return null;
  }

  const sid = req.cookies?.[SESSION_COOKIE];
  if (typeof sid !== "string" || sid.length < 16) return null;

  try {
    const prisma = await getPrisma();
    const session = await prisma.session.findUnique({
      where: { id: sid },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    return {
      id: session.user.id,
      handle: session.user.handle,
      displayName: session.user.displayName ?? null,
      avatarUrl: session.user.avatarUrl ?? null,
      email: session.user.email ?? null,
    };
  } catch (err: any) {
    // Distinguish between expected 'no session' cases and genuine DB errors.
    const msg = err?.message ?? String(err);
    const isDbError = /ECONNREFUSED|ENOTFOUND|payload|wire|timeout/i.test(msg);
    if (isDbError) {
      console.error("[auth] CRITICAL DB ERROR during session lookup:", msg, err);
      req.authSessionLookupError = msg;
    } else {
      console.warn("[auth] Session lookup failed (stale cookie or transient error):", msg);
    }
    // Return null to mark user as unauthenticated, but do not crash the request.
    return null;
  }
}

export async function createSessionAndSetCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
): Promise<void> {
  // Validate host header to prevent setting cookies for disallowed hosts
  if (!isHostAllowed(req)) {
    console.warn("[auth] Attempted to set session cookie from disallowed host:", req.headers.host);
    const err: any = new Error("forbidden");
    err.statusCode = 403;
    throw err;
  }

  const sid = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const prisma = await getPrisma();
  await prisma.session.create({
    data: { id: sid, userId, expiresAt },
  });

  reply.setCookie(SESSION_COOKIE, sid, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProbablySecure(req),
    expires: expiresAt,
  });
}

export async function clearSessionCookieAndDb(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Validate host header to prevent clearing sessions from disallowed hosts
  if (!isHostAllowed(req)) {
    console.warn("[auth] Attempted to clear session from disallowed host:", req.headers.host);
    return;
  }

  const sid = req.cookies?.[SESSION_COOKIE];
  if (typeof sid === "string" && sid.length > 0) {
    const prisma = await getPrisma();
    await prisma.session.deleteMany({ where: { id: sid } });
  }

  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function requireUser(req: FastifyRequest): asserts req is FastifyRequest & { user: AuthUser } {
  if (!req.user) {
    const err: any = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

export function registerAuthDecorators(app: FastifyInstance) {
  app.decorateRequest("user", null);
  app.decorateRequest("authSessionLookupError", null);
}
