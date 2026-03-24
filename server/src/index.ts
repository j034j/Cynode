import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import {
  ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerRoutes } from "./routes.js";
import { closePrisma, getPrisma } from "./db.js";
import { loadUserFromSession, registerAuthDecorators } from "./auth.js";
import { registerGithubOAuth } from "./oauth-github.js";

export const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
registerAuthDecorators(app);

// Rate limiting - protect against abuse
const rateLimitConfig = {
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute",
  keyGenerator: (req: any) => {
    // Use X-Forwarded-For if behind a proxy, otherwise use remote IP
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0].trim();
    }
    return req.ip || "unknown";
  },
  // Skip rate limiting for certain paths
  addHeadersOnExceeding: {
    "x-ratelimit-limit": true,
    "x-ratelimit-remaining": true,
    "x-ratelimit-reset": true,
  },
};
await app.register(fastifyRateLimit, rateLimitConfig);

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) || ["*"];
await app.register(fastifyCors, {
  origin: corsOrigins.length === 1 && corsOrigins[0] === "*"
    ? true
    : corsOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
});

// Be tolerant of clients that send `Content-Type: application/json` with an empty body.
// Fastify's default parser throws `FST_ERR_CTP_EMPTY_JSON_BODY`, which is noisy for DELETE/GET calls.
app.removeContentTypeParser("application/json");
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    if (body === "") return done(null, null);
    try {
      return done(null, JSON.parse(body as string));
    } catch (err) {
      return done(err as Error, undefined);
    }
  },
);

await app.register(fastifyCookie);
await app.register(fastifyMultipart, {
  limits: {
    // Enough for short narration + small music bed; tune for production.
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

// Only enable raw body for routes that opt-in (Stripe webhooks).
await app.register(rawBody, {
  field: "rawBody",
  global: false,
  // Keep as string to avoid fastify-raw-body trying to install its own JSON content-type parser,
  // since we already have a custom application/json parser registered above.
  // Stripe webhook verification accepts a string payload.
  encoding: "utf8",
  runFirst: true,
});

app.addHook("preHandler", async (req) => {
  req.user = await loadUserFromSession(req);
});

await app.register(fastifySwagger, {
  openapi: {
    info: { title: "Cynode API", version: "0.1.0" },
  },
  transform: jsonSchemaTransform,
});
await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

await registerGithubOAuth(app);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicRoot = path.resolve(__dirname, "..", "..", "public");

await app.register(fastifyStatic, {
  root: publicRoot,
});

await registerRoutes(app);

// Short URL redirect to the SPA with a share code.
app.get<{ Params: { code: string } }>("/s/:code", async (req, reply) => {
  const code = encodeURIComponent(req.params.code);
  return reply.redirect(`/?share=${code}`);
});

// Branded namespace: /{handle-or-orgSlug}/{code}
app.get<{ Params: { namespace: string; code: string } }>(
  "/:namespace/:code(^[0-9A-Za-z]{4,32}$)",
  async (req, reply) => {
    const code = encodeURIComponent(req.params.code);
    const ns = encodeURIComponent(req.params.namespace);
    return reply.redirect(`/?share=${code}&ns=${ns}`);
  },
);

// Custom domain support: https://brand.example/{code}
app.get<{ Params: { code: string } }>("/:code(^[0-9A-Za-z]{4,32}$)", async (req, reply) => {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return reply.callNotFound();
  const host = hostHeader.split(":")[0].toLowerCase();

  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({ where: { customDomain: host } });
  if (!org) return reply.callNotFound();

  const code = encodeURIComponent(req.params.code);
  return reply.redirect(`/?share=${code}&ns=${encodeURIComponent(org.slug)}`);
});

// SPA entry.
app.get("/pricing", async (_req, reply) => reply.sendFile("pricing.html"));
app.get("/desktop", async (_req, reply) => reply.sendFile("desktop.html"));
app.get("/analytics", async (_req, reply) => reply.sendFile("analytics.html"));
app.get("/", async (_req, reply) => reply.sendFile("index.html"));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

app.addHook("onClose", async () => {
  await closePrisma();
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err, signal }, "shutdown failed");
    process.exitCode = 1;
  }
}

if (!process.env.VERCEL) {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ port, host });
}

export default async function (req: any, res: any) {
  await app.ready();
  app.server.emit('request', req, res);
}
