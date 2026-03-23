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

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

function isProbablySecure(req: FastifyRequest): boolean {
  const configuredOrigin = process.env.APP_BASE_URL ? getPublicOrigin(req) : null;
  if (configuredOrigin) return configuredOrigin.startsWith("https://");
  const xfProto = req.headers["x-forwarded-proto"];
  if (typeof xfProto === "string") return xfProto.split(",")[0].trim() === "https";
  // Local dev usually uses http.
  return false;
}

export async function loadUserFromSession(req: FastifyRequest): Promise<AuthUser | null> {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (typeof sid !== "string" || sid.length < 16) return null;

  const prisma = getPrisma();
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
}

export async function createSessionAndSetCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
): Promise<void> {
  const sid = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const prisma = getPrisma();
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
  const sid = req.cookies?.[SESSION_COOKIE];
  if (typeof sid === "string" && sid.length > 0) {
    const prisma = getPrisma();
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
}
