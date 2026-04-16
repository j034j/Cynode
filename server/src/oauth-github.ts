import type { FastifyInstance } from "fastify";
import fastifyOauth2, { type FastifyOAuth2Options } from "@fastify/oauth2";
import { z } from "zod/v4";
import { createSessionAndSetCookie } from "./auth.js";
import { getPrisma } from "./db.js";

const githubOAuthConfiguration = {
  tokenHost: "https://github.com",
  tokenPath: "/login/oauth/access_token",
  authorizePath: "/login/oauth/authorize",
} satisfies NonNullable<FastifyOAuth2Options["credentials"]["auth"]>;

type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
};

function slugifyHandle(raw: string): string {
  // Keep it predictable and URL-safe.
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return cleaned || "user";
}

async function getGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "cynode",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`github_user_fetch_failed:${res.status}`);
  const json = await res.json();
  const schema = z.object({
    id: z.number().int(),
    login: z.string(),
    name: z.string().nullable(),
    avatar_url: z.string().url().nullable(),
    email: z.string().email().nullable(),
  });
  const parsed = schema.parse(json);
  return {
    id: parsed.id,
    login: parsed.login,
    name: parsed.name ?? null,
    avatar_url: parsed.avatar_url ?? null,
    email: parsed.email ?? null,
  };
}

async function allocateUniqueHandle(base: string): Promise<string> {
  const prisma = await getPrisma();
  const root = slugifyHandle(base);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}${i + 1}`;
    const existing = await prisma.user.findUnique({ where: { handle: candidate } });
    if (!existing) return candidate;
  }
  // Worst-case fallback.
  return `${root}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function registerGithubOAuth(app: FastifyInstance) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackUri = process.env.GITHUB_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUri) {
    // Auth remains optional; endpoints will return 501.
    app.get("/auth/github", async (_req, reply) => reply.code(501).send({ error: "oauth_not_configured" }));
    app.get("/auth/github/callback", async (_req, reply) => reply.code(501).send({ error: "oauth_not_configured" }));
    return;
  }

  const opts: FastifyOAuth2Options = {
    name: "githubOAuth2",
    scope: ["read:user", "user:email"],
    credentials: { client: { id: clientId, secret: clientSecret }, auth: githubOAuthConfiguration },
    startRedirectPath: "/auth/github",
    callbackUri,
  };

  await app.register(fastifyOauth2, opts);

  app.get("/auth/github/callback", async function (this: FastifyInstance, req, reply) {
    const oauth = this.githubOAuth2;
    if (!oauth) throw new Error("github_oauth_not_registered");
    const token = await oauth.getAccessTokenFromAuthorizationCodeFlow(req);
    const accessToken = token.token.access_token;

    const gh = await getGithubUser(accessToken);

    const prisma = await getPrisma();
    const provider = "github";
    const providerUserId = String(gh.id);

    const existingAccount = await prisma.oAuthAccount.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      include: { user: true },
    });

    let userId: string;
    if (existingAccount) {
      userId = existingAccount.userId;
      // Best-effort profile refresh.
      await prisma.user.update({
        where: { id: userId },
        data: {
          displayName: gh.name ?? existingAccount.user.displayName,
          avatarUrl: gh.avatar_url ?? existingAccount.user.avatarUrl,
        },
      });
    } else {
      const handle = await allocateUniqueHandle(gh.login);
      const created = await prisma.user.create({
        data: {
          handle,
          displayName: gh.name,
          avatarUrl: gh.avatar_url,
          email: gh.email,
          oauthAccounts: {
            create: {
              provider,
              providerUserId,
            },
          },
        },
      });
      userId = created.id;
    }

    await createSessionAndSetCookie(reply, req, userId);
    return reply.redirect("/");
  });
}
