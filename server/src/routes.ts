import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import { compactGraphStateForPersistence, createGraph, createShareFromGraphState, getGraph, getGraphByShareCode, putGraph } from "./store.js";
import { clearSessionCookieAndDb, createSessionAndSetCookie, requireUser } from "./auth.js";
import { getPrisma } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { deleteStoredMedia, storeMultipartAudio, readStoredMediaStream } from "./media.js";
import { createReadStream } from "node:fs";
import { registerBillingRoutes } from "./billing.js";
import crypto from "node:crypto";
import { getPlans, isUnlimitedUser, planByKey, addUsage, creditsForMediaBytes, creditsForSavedLink, monthPeriodStart, nextMonthPeriodStart } from "./usage.js";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import { buildAppUrl, getPublicOrigin, getRequestProtocol } from "./origin.js";
import { pushUserWorkToCloud, pullUserWorkFromCloud, findAndPullRemoteUser } from "./sync.js";

// Helper: await a promise but don't block forever — useful for sync ops.
async function awaitWithTimeout<T>(p: Promise<T>, ms = 2500): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T | null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// JSON object keys are always strings; we accept numeric-string keys like "1", "2", ...
const NodeUrlsSchema = z.record(z.string().regex(/^\d+$/), z.string());
const NodeCaptionsSchema = z.record(
  z.string().regex(/^\d+$/),
  z.object({ title: z.string(), caption: z.string() })
);

const GraphSchema = z.object({
  id: z.string(),
  nodeCount: z.number().int().min(1).max(20),
  lastSelectedNode: z.number().int().min(1).max(20).nullable(),
  nodeUrls: NodeUrlsSchema,
  nodeCaptions: NodeCaptionsSchema.optional(),
  nodePauseSecByNode: z.record(z.string().regex(/^\d+$/), z.number()).optional(),
  updatedAt: z.string(),
});

const GraphWithTopicSchema = GraphSchema.extend({
  topic: z.string().nullable().optional(),
  media: z
    .object({
      background: z
        .object({
          id: z.string(),
          url: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int(),
        })
        .nullable(),
      voiceByNode: z.record(
        z.string().regex(/^\d+$/),
        z.object({
          id: z.string(),
          url: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int(),
        }),
      ),
      filesByNode: z.record(
        z.string().regex(/^\d+$/),
        z.object({
          id: z.string(),
          url: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int(),
        }),
      ).optional(),
    })
    .optional(),
});

const ShareCodeSchema = z.string().min(4).max(32).regex(/^[0-9A-Za-z]+$/);
const MediaIdSchema = z.string().uuid();

const AnalyticsEventTypeSchema = z.enum([
  "share_view",
  "node_preview",
  "node_visit",
  "play_start",
  "play_stop",
]);

const AnalyticsIngestSchema = z.object({
  shareCode: ShareCodeSchema,
  type: AnalyticsEventTypeSchema,
  nodeIndex: z.number().int().min(1).max(20).optional(),
  url: z.string().max(2048).optional(),
  pagePath: z.string().max(1024).optional(),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
  utmContent: z.string().max(255).optional(),
  utmTerm: z.string().max(255).optional(),
});

const AnalyticsRangeSchema = z.enum(["24h", "7d", "30d", "90d", "365d", "custom"]);
const AnalyticsScopeSchema = z.string().regex(/^(me|org:[0-9a-fA-F-]+)$/);
const AnalyticsOverviewQuerySchema = z.object({
  scope: AnalyticsScopeSchema.default("me"),
  range: AnalyticsRangeSchema.default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
});

const PlansResponseSchema = z.array(
  z.object({
    key: z.string(),
    name: z.string(),
    monthlyCredits: z.number().int().nullable(),
    maxSavedLinksPerMonth: z.number().int().nullable(),
    maxMediaMBPerMonth: z.number().int().nullable(),
    analyticsRetentionDays: z.number().int().nullable(),
  }),
);

const UsageResponseSchema = z.object({
  subject: z.object({
    type: z.enum(["user", "org"]),
    id: z.string(),
  }),
  plan: z.object({
    key: z.string(),
    name: z.string(),
    status: z.string(),
    unlimited: z.boolean(),
  }),
  period: z.object({
    start: z.string(),
    end: z.string(),
  }),
  limits: z.object({
    monthlyCredits: z.number().int().nullable(),
    maxSavedLinksPerMonth: z.number().int().nullable(),
    maxMediaMBPerMonth: z.number().int().nullable(),
  }),
  usage: z.object({
    creditsUsed: z.number().int(),
    savedLinksCreated: z.number().int(),
    mediaBytesUploaded: z.number().int(),
    analyticsEvents: z.number().int(),
  }),
});

const ShareCreateBodySchema = z.object({
  nodeCount: z.number().int().min(1).max(20),
  lastSelectedNode: z.number().int().min(1).max(20).nullable(),
  nodeUrls: NodeUrlsSchema,
  nodeCaptions: NodeCaptionsSchema.optional(),
  nodePauseSecByNode: z.record(z.string().regex(/^\d+$/), z.number()).optional(),
  organizationId: z.string().uuid().optional(),
  topic: z.string().min(1).max(80).optional(),
});

const ShareCreateResponseSchema = z.object({
  code: z.string(),
  shareUrl: z.string(),
  graphId: z.string(),
  createdAt: z.string(),
  topic: z.string().nullable().optional(),
});

const SavedListSchema = z.array(
  z.object({
    code: z.string(),
    shareUrl: z.string(),
    createdAt: z.string(),
    namespace: z.string().nullable(),
    topic: z.string().nullable().optional(),
  }),
);

function formatShareUrlForOwner(baseUrl: string, req: any, owner: { type: "user"; handle: string } | { type: "org"; slug: string; customDomain: string | null }, code: string): string {
  if (owner.type === "org") {
    if (owner.customDomain) return `${getProto(req)}://${owner.customDomain}/${code}`;
    return `${baseUrl}/${owner.slug}/${code}`;
  }
  return `${baseUrl}/${owner.handle}/${code}`;
}

const OrgCreateSchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(40).regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/),
  customDomain: z.string().min(3).max(255).optional(),
});

const RegisterSchema = z.object({
  handle: z.string().min(2).max(40).regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/),
  email: z.string().email(),
  password: z.string().min(1).max(200),
  displayName: z.string().min(1).max(80).optional(),
});

const LoginSchema = z.object({
  identifier: z.string().min(2).max(255), // email or handle
  password: z.string().min(1).max(200),
});

function getBaseUrl(req: Parameters<typeof getPublicOrigin>[0]): string {
  return getPublicOrigin(req);
}

async function assertCanEditSavedShare(prisma: any, user: any, code: string) {
  const share = await prisma.share.findUnique({
    where: { code },
    include: { organization: { include: { subscription: true } } },
  });
  if (!share || share.saved !== true) return { share: null, error: "not_found" };

  if (share.organizationId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: share.organizationId } },
    });
    if (!membership) return { share: null, error: "forbidden" };
    return { share, error: null };
  }

  if (share.createdByUserId !== user.id) return { share: null, error: "forbidden" };
  return { share, error: null };
}

function getProto(req: Parameters<typeof getRequestProtocol>[0]): string {
  return getRequestProtocol(req);
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUtc(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function computeAnalyticsWindow(range: z.infer<typeof AnalyticsRangeSchema>, from?: string, to?: string) {
  const now = new Date();
  const end = range === "custom" && to ? new Date(to) : now;
  let start: Date;

  if (range === "custom" && from) {
    start = new Date(from);
  } else {
    const endDay = startOfDayUtc(end);
    const days = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 365;
    start = range === "24h" ? new Date(end.getTime() - 24 * 60 * 60 * 1000) : addDaysUtc(endDay, -(days - 1));
  }

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("invalid_date_range");
  }

  const inclusiveEnd = new Date(end);
  const exclusiveEnd =
    range === "24h" || range === "custom"
      ? new Date(inclusiveEnd.getTime() + 1)
      : addDaysUtc(startOfDayUtc(inclusiveEnd), 1);
  const previousStart = new Date(start.getTime() - (exclusiveEnd.getTime() - start.getTime()));
  const previousEnd = new Date(start);

  return {
    start,
    endExclusive: exclusiveEnd,
    previousStart,
    previousEnd,
    bucket: range === "24h" ? "hour" : "day",
  };
}

async function resolveAnalyticsScope(prisma: any, user: any, scopeRaw: string) {
  if (scopeRaw === "me") {
    const shares = await prisma.share.findMany({
      where: { createdByUserId: user.id, saved: true },
      select: {
        code: true,
        topic: true,
        createdAt: true,
        organizationId: true,
        createdByUserId: true,
        createdByUser: { select: { handle: true, displayName: true } },
        organization: { select: { slug: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return {
      scope: "me",
      label: `Personal (${user.handle})`,
      shares,
    };
  }

  const orgId = scopeRaw.slice(4);
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
    include: { organization: true },
  });
  if (!membership) {
    const err: any = new Error("forbidden");
    err.code = "forbidden";
    throw err;
  }

  const shares = await prisma.share.findMany({
    where: { organizationId: orgId, saved: true },
    select: {
      code: true,
      topic: true,
      createdAt: true,
      organizationId: true,
      createdByUserId: true,
      createdByUser: { select: { handle: true, displayName: true } },
      organization: { select: { slug: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return {
    scope: scopeRaw,
    label: `Org (${membership.organization.slug})`,
    shares,
  };
}

function groupByCodeRows(rows: any[], keyMap: Record<string, string>) {
  const byCode: Record<string, any> = {};
  for (const row of rows) {
    const code = String(row.code);
    if (!byCode[code]) byCode[code] = { code };
    for (const [src, dst] of Object.entries(keyMap)) {
      byCode[code][dst] = Number(row[src]) || 0;
    }
  }
  return byCode;
}

function safePct(num: number, den: number) {
  return den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0;
}

function safeDeltaPct(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

export async function registerRoutes(app: FastifyInstance) {
  // Public media serving (no auth): anyone with the share link can fetch these assets.
  app.get<{ Params: { id: string } }>(
    "/m/:id",
    {
      schema: {
        params: z.object({ id: MediaIdSchema }),
        response: {
          200: z.any(),
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const prisma = await getPrisma();
      const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id } });
      if (!asset) return reply.code(404).send({ error: "not_found" });

      const { absPath } = await readStoredMediaStream(asset.storagePath);
      reply.header("cache-control", "public, max-age=31536000, immutable");
      reply.type(asset.mimeType || "application/octet-stream");
      return reply.send(createReadStream(absPath));
    },
  );

  await registerBillingRoutes(app);

  // Public plan catalog (for pricing UI).
  app.get(
    "/api/v1/plans",
    {
      schema: {
        response: { 200: PlansResponseSchema },
      },
    },
    async () => getPlans(),
  );

  // Usage for the signed-in user (current month).
  app.get(
    "/api/v1/usage/me",
    {
      schema: {
        response: {
          200: UsageResponseSchema,
          401: z.object({ error: z.literal("unauthorized") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const prisma = await getPrisma();
      const sub = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
      const planKey = isUnlimitedUser(user) ? "ultra" : sub?.planKey ?? "free";
      const status = isUnlimitedUser(user) ? "active" : sub?.status ?? "free";
      const plan = planByKey(planKey);
      const unlimited = isUnlimitedUser(user) || plan.key === "ultra";

      const periodStart = monthPeriodStart(new Date());
      const periodEnd = nextMonthPeriodStart(new Date());
      const counter = await prisma.usageCounter.findUnique({
        where: { subjectType_subjectId_periodStart: { subjectType: "user", subjectId: user.id, periodStart } },
      });

      return {
        subject: { type: "user", id: user.id },
        plan: { key: plan.key, name: plan.name, status, unlimited },
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        limits: {
          monthlyCredits: plan.monthlyCredits,
          maxSavedLinksPerMonth: plan.maxSavedLinksPerMonth,
          maxMediaMBPerMonth: plan.maxMediaMBPerMonth,
        },
        usage: {
          creditsUsed: counter?.creditsUsed ?? 0,
          savedLinksCreated: counter?.savedLinksCreated ?? 0,
          mediaBytesUploaded: counter?.mediaBytesUploaded ?? 0,
          analyticsEvents: counter?.analyticsEvents ?? 0,
        },
      };
    },
  );

  // --- Analytics ingest (public) ---
  app.post<{ Body: z.infer<typeof AnalyticsIngestSchema> }>(
    "/api/v1/analytics/event",
    {
      schema: {
        body: AnalyticsIngestSchema,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const prisma = await getPrisma();
      const share = await prisma.share.findUnique({ where: { code: req.body.shareCode } });
      if (!share) return { ok: true }; // ignore unknown codes

      const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
      const ref = typeof req.headers["referer"] === "string" ? req.headers["referer"] : null;
      const ipHeader = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
      const ip = (ipHeader.split(",")[0]?.trim() || (req as any).ip || "").toString();
      const salt = process.env.ANALYTICS_SALT || "dev";
      const viewerHash = crypto.createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex");

      const parser = UAParser(ua);
      const res = parser;
      const device = res.device.type || "desktop";
      const browser = res.browser.name || null;
      const os = res.os.name || null;

      const geo = ip ? geoip.lookup(ip) : null;
      const country = geo ? geo.country : null;
      const city = geo ? geo.city : null;

      let refererSource = null;
      if (ref) {
        try {
          const u = new URL(ref);
          refererSource = u.hostname;
        } catch (e) { }
      }

      await prisma.analyticsEvent.create({
        data: {
          shareCode: req.body.shareCode,
          type: req.body.type,
          nodeIndex: req.body.nodeIndex ?? null,
          url: req.body.url ?? null,
          viewerHash,
          referrer: ref,
          userAgent: ua || null,
          device,
          browser,
          os,
          country,
          city,
          refererSource,
          pagePath: req.body.pagePath ?? null,
          utmSource: req.body.utmSource ?? null,
          utmMedium: req.body.utmMedium ?? null,
          utmCampaign: req.body.utmCampaign ?? null,
          utmContent: req.body.utmContent ?? null,
          utmTerm: req.body.utmTerm ?? null,
        },
      });

      // Usage accounting (best-effort). We do not block ingest on quota for now.
      try {
        if (share.organizationId) await addUsage("org", share.organizationId, { analyticsEvents: 1 });
        else if (share.createdByUserId) await addUsage("user", share.createdByUserId, { analyticsEvents: 1 });
      } catch (_) { }
      return { ok: true };
    },
  );

  // --- Analytics dashboards (auth) ---
  app.get(
    "/api/v1/analytics/saved",
    {
      schema: {
        response: {
          200: z.array(
            z.object({
              code: z.string(),
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
            }),
          ),
          401: z.object({ error: z.literal("unauthorized") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();
      const shares = await prisma.share.findMany({
        where: { createdByUserId: user.id, saved: true },
        select: { code: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const codes = shares.map((s) => s.code);
      if (codes.length === 0) return [];

      const rowsViews = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as views, COUNT(DISTINCT viewerHash) as uniques
         FROM AnalyticsEvent
         WHERE type='share_view' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );
      const rowsPreviews = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as previews
         FROM AnalyticsEvent
         WHERE type='node_preview' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );
      const rowsVisits = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as visits
         FROM AnalyticsEvent
         WHERE type='node_visit' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );

      const byCode: Record<string, any> = {};
      for (const c of codes) byCode[c] = { code: c, views: 0, uniques: 0, previews: 0, visits: 0 };
      for (const r of rowsViews) {
        if (!byCode[r.code]) continue;
        byCode[r.code].views = Number(r.views) || 0;
        byCode[r.code].uniques = Number(r.uniques) || 0;
      }
      for (const r of rowsPreviews) {
        if (!byCode[r.code]) continue;
        byCode[r.code].previews = Number(r.previews) || 0;
      }
      for (const r of rowsVisits) {
        if (!byCode[r.code]) continue;
        byCode[r.code].visits = Number(r.visits) || 0;
      }
      return codes.map((c) => byCode[c]);
    },
  );

  app.get<{ Params: { orgId: string } }>(
    "/api/v1/analytics/org/:orgId",
    {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        response: {
          200: z.array(
            z.object({
              code: z.string(),
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
            }),
          ),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();
      const membership = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId: req.params.orgId } },
      });
      if (!membership) return reply.code(403).send({ error: "forbidden" });

      const shares = await prisma.share.findMany({
        where: { organizationId: req.params.orgId, saved: true },
        select: { code: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const codes = shares.map((s) => s.code);
      if (codes.length === 0) return [];

      const rowsViews = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as views, COUNT(DISTINCT viewerHash) as uniques
         FROM AnalyticsEvent
         WHERE type='share_view' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );
      const rowsPreviews = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as previews
         FROM AnalyticsEvent
         WHERE type='node_preview' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );
      const rowsVisits = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code, COUNT(*) as visits
         FROM AnalyticsEvent
         WHERE type='node_visit' AND shareCode IN (${codes.map(() => "?").join(",")})
         GROUP BY shareCode`,
        ...codes,
      );

      const byCode: Record<string, any> = {};
      for (const c of codes) byCode[c] = { code: c, views: 0, uniques: 0, previews: 0, visits: 0 };
      for (const r of rowsViews) {
        if (!byCode[r.code]) continue;
        byCode[r.code].views = Number(r.views) || 0;
        byCode[r.code].uniques = Number(r.uniques) || 0;
      }
      for (const r of rowsPreviews) {
        if (!byCode[r.code]) continue;
        byCode[r.code].previews = Number(r.previews) || 0;
      }
      for (const r of rowsVisits) {
        if (!byCode[r.code]) continue;
        byCode[r.code].visits = Number(r.visits) || 0;
      }
      return codes.map((c) => byCode[c]);
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/v1/analytics/share/:code",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        response: {
          200: z.object({
            code: z.string(),
            views: z.number().int(),
            uniques: z.number().int(),
            previewsByNode: z.record(z.string(), z.number().int()),
            visitsByNode: z.record(z.string(), z.number().int()),
            dailyViews14d: z.array(z.object({ day: z.string(), views: z.number().int() })),
            devices: z.record(z.string(), z.number().int()),
            browsers: z.record(z.string(), z.number().int()),
            os: z.record(z.string(), z.number().int()),
            countries: z.record(z.string(), z.number().int()),
            referers: z.record(z.string(), z.number().int()),
          }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();
      const share = await prisma.share.findUnique({ where: { code: req.params.code } });
      if (!share) return reply.code(404).send({ error: "not_found" });
      if (share.organizationId) {
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: share.organizationId } },
        });
        if (!membership) return reply.code(403).send({ error: "forbidden" });
      } else if (share.createdByUserId !== user.id) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const code = req.params.code;
      const viewsRow = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(*) as views, COUNT(DISTINCT viewerHash) as uniques
         FROM AnalyticsEvent WHERE shareCode=? AND type='share_view'`,
        code,
      );
      const views = Number(viewsRow?.[0]?.views) || 0;
      const uniques = Number(viewsRow?.[0]?.uniques) || 0;

      const previewsRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT nodeIndex, COUNT(*) as c
         FROM AnalyticsEvent WHERE shareCode=? AND type='node_preview' AND nodeIndex IS NOT NULL
         GROUP BY nodeIndex`,
        code,
      );
      const visitsRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT nodeIndex, COUNT(*) as c
         FROM AnalyticsEvent WHERE shareCode=? AND type='node_visit' AND nodeIndex IS NOT NULL
         GROUP BY nodeIndex`,
        code,
      );
      const previewsByNode: Record<string, number> = {};
      const visitsByNode: Record<string, number> = {};
      for (const r of previewsRows) previewsByNode[String(r.nodeIndex)] = Number(r.c) || 0;
      for (const r of visitsRows) visitsByNode[String(r.nodeIndex)] = Number(r.c) || 0;

      const dailyRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT substr(createdAt, 1, 10) as day, COUNT(*) as views
         FROM AnalyticsEvent
         WHERE shareCode=? AND type='share_view' AND createdAt >= datetime('now','-13 days')
         GROUP BY substr(createdAt, 1, 10)
         ORDER BY day ASC`,
        code,
      );

      const toMap = (arr: any[], key: string) => arr.reduce((acc, r) => { acc[String(r[key])] = Number(r.c) || 0; return acc; }, {} as Record<string, number>);

      const devicesRows = await prisma.$queryRawUnsafe<any[]>(`SELECT device, COUNT(*) as c FROM AnalyticsEvent WHERE shareCode=? AND type='share_view' AND device IS NOT NULL GROUP BY device`, code);
      const browsersRows = await prisma.$queryRawUnsafe<any[]>(`SELECT browser, COUNT(*) as c FROM AnalyticsEvent WHERE shareCode=? AND type='share_view' AND browser IS NOT NULL GROUP BY browser`, code);
      const osRows = await prisma.$queryRawUnsafe<any[]>(`SELECT os, COUNT(*) as c FROM AnalyticsEvent WHERE shareCode=? AND type='share_view' AND os IS NOT NULL GROUP BY os`, code);
      const countriesRows = await prisma.$queryRawUnsafe<any[]>(`SELECT country, COUNT(*) as c FROM AnalyticsEvent WHERE shareCode=? AND type='share_view' AND country IS NOT NULL GROUP BY country`, code);
      const referersRows = await prisma.$queryRawUnsafe<any[]>(`SELECT refererSource, COUNT(*) as c FROM AnalyticsEvent WHERE shareCode=? AND type='share_view' AND refererSource IS NOT NULL GROUP BY refererSource`, code);

      return {
        code,
        views,
        uniques,
        previewsByNode,
        visitsByNode,
        dailyViews14d: dailyRows.map((r) => ({ day: String(r.day), views: Number(r.views) || 0 })),
        devices: toMap(devicesRows, 'device'),
        browsers: toMap(browsersRows, 'browser'),
        os: toMap(osRows, 'os'),
        countries: toMap(countriesRows, 'country'),
        referers: toMap(referersRows, 'refererSource'),
      };
    },
  );

  app.get<{ Querystring: z.infer<typeof AnalyticsOverviewQuerySchema> }>(
    "/api/v1/analytics/v2/overview",
    {
      schema: {
        querystring: AnalyticsOverviewQuerySchema,
        response: {
          200: z.object({
            scope: z.string(),
            label: z.string(),
            range: z.string(),
            window: z.object({ start: z.string(), endExclusive: z.string() }),
            totals: z.object({
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
              playStarts: z.number().int(),
              playStops: z.number().int(),
              previewRate: z.number(),
              visitRate: z.number(),
              visitPerPreviewRate: z.number(),
            }),
            previousTotals: z.object({
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
            }),
            trend: z.object({
              viewsDeltaPct: z.number(),
              uniquesDeltaPct: z.number(),
              visitsDeltaPct: z.number(),
            }),
            activeShares: z.number().int(),
            series: z.array(z.object({
              bucket: z.string(),
              views: z.number().int(),
              visits: z.number().int(),
              previews: z.number().int(),
            })),
            topCampaigns: z.array(z.object({
              campaign: z.string(),
              views: z.number().int(),
              uniques: z.number().int(),
              visits: z.number().int(),
            })),
            topTopics: z.array(z.object({
              topic: z.string(),
              views: z.number().int(),
              visits: z.number().int(),
            })),
            topReferrers: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topCountries: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topCities: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topDevices: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topBrowsers: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topOS: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topUrls: z.array(z.object({ url: z.string(), visits: z.number().int() })),
            topSources: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topMediums: z.array(z.object({ label: z.string(), count: z.number().int() })),
            topShares: z.array(z.object({
              code: z.string(),
              topic: z.string().nullable(),
              createdAt: z.string(),
              ownerLabel: z.string(),
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
              previewRate: z.number(),
              ctr: z.number(),
            })),
          }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();

      let scopeInfo;
      try {
        scopeInfo = await resolveAnalyticsScope(prisma, user, req.query.scope);
      } catch (err: any) {
        if (err?.code === "forbidden") return reply.code(403).send({ error: "forbidden" });
        throw err;
      }

      const codes = scopeInfo.shares.map((s: any) => s.code);
      const window = computeAnalyticsWindow(req.query.range, req.query.from, req.query.to);
      if (codes.length === 0) {
        return {
          scope: scopeInfo.scope,
          label: scopeInfo.label,
          range: req.query.range,
          window: { start: window.start.toISOString(), endExclusive: window.endExclusive.toISOString() },
          totals: { views: 0, uniques: 0, previews: 0, visits: 0, playStarts: 0, playStops: 0, previewRate: 0, visitRate: 0, visitPerPreviewRate: 0 },
          previousTotals: { views: 0, uniques: 0, previews: 0, visits: 0 },
          trend: { viewsDeltaPct: 0, uniquesDeltaPct: 0, visitsDeltaPct: 0 },
          activeShares: 0,
          series: [],
          topCampaigns: [],
          topTopics: [],
          topReferrers: [],
          topCountries: [],
          topCities: [],
          topDevices: [],
          topBrowsers: [],
          topOS: [],
          topUrls: [],
          topSources: [],
          topMediums: [],
          topShares: [],
        };
      }

      const placeholders = codes.map(() => "?").join(",");
      const currentRangeParams = [...codes, window.start.toISOString(), window.endExclusive.toISOString()];
      const previousRangeParams = [...codes, window.previousStart.toISOString(), window.previousEnd.toISOString()];
      const countRow = async (type: string, params: any[]) => {
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT COUNT(*) as count, COUNT(DISTINCT viewerHash) as uniques
           FROM AnalyticsEvent
           WHERE shareCode IN (${placeholders}) AND type=? AND createdAt >= ? AND createdAt < ?`,
          ...params.slice(0, codes.length), type, ...params.slice(codes.length),
        );
        return {
          count: Number(rows?.[0]?.count) || 0,
          uniques: Number(rows?.[0]?.uniques) || 0,
        };
      };

      const currentViews = await countRow("share_view", currentRangeParams);
      const currentPreviews = await countRow("node_preview", currentRangeParams);
      const currentVisits = await countRow("node_visit", currentRangeParams);
      const currentStarts = await countRow("play_start", currentRangeParams);
      const currentStops = await countRow("play_stop", currentRangeParams);

      const previousViews = await countRow("share_view", previousRangeParams);
      const previousPreviews = await countRow("node_preview", previousRangeParams);
      const previousVisits = await countRow("node_visit", previousRangeParams);

      const bucketExpr =
        window.bucket === "hour"
          ? `substr(createdAt, 1, 13) || ':00:00Z'`
          : `substr(createdAt, 1, 10)`;
      const seriesRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketExpr} as bucket,
                SUM(CASE WHEN type='share_view' THEN 1 ELSE 0 END) as views,
                SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits,
                SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND createdAt >= ? AND createdAt < ?
         GROUP BY ${bucketExpr}
         ORDER BY bucket ASC`,
        ...currentRangeParams,
      );

      const topCampaignRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(utmCampaign,''), '(unattributed)') as campaign,
                COUNT(CASE WHEN type='share_view' THEN 1 END) as views,
                COUNT(DISTINCT CASE WHEN type='share_view' THEN viewerHash END) as uniques,
                COUNT(CASE WHEN type='node_visit' THEN 1 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(utmCampaign,''), '(unattributed)')
         ORDER BY views DESC
         LIMIT 8`,
        ...currentRangeParams,
      );

      const topTopicRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(s.topic,''), '(untitled)') as topic,
                SUM(CASE WHEN e.type='share_view' THEN 1 ELSE 0 END) as views,
                SUM(CASE WHEN e.type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent e
         JOIN Share s ON s.code = e.shareCode
         WHERE e.shareCode IN (${placeholders}) AND e.createdAt >= ? AND e.createdAt < ?
         GROUP BY COALESCE(NULLIF(s.topic,''), '(untitled)')
         ORDER BY views DESC
         LIMIT 8`,
        ...currentRangeParams,
      );

      const topRefRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(refererSource,''), '(direct)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(refererSource,''), '(direct)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topCountryRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(country,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(country,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topCityRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(city,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(city,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topDeviceRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(device,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(device,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topBrowserRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(browser,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(browser,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topOSRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(os,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(os,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topUrlRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT url, COUNT(*) as visits
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='node_visit' AND createdAt >= ? AND createdAt < ? AND url IS NOT NULL
         GROUP BY url
         ORDER BY visits DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topSourceRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(utmSource,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(utmSource,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );
      const topMediumRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(NULLIF(utmMedium,''), '(unknown)') as label, COUNT(*) as count
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND type='share_view' AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(utmMedium,''), '(unknown)')
         ORDER BY count DESC
         LIMIT 8`,
        ...currentRangeParams,
      );

      const shareRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code,
                SUM(CASE WHEN type='share_view' THEN 1 ELSE 0 END) as views,
                COUNT(DISTINCT CASE WHEN type='share_view' THEN viewerHash END) as uniques,
                SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews,
                SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND createdAt >= ? AND createdAt < ?
         GROUP BY shareCode`,
        ...currentRangeParams,
      );

      const shareMetricMap = groupByCodeRows(shareRows, { views: "views", uniques: "uniques", previews: "previews", visits: "visits" });
      const topShares = scopeInfo.shares
        .map((share: any) => {
          const metrics = shareMetricMap[share.code] || { views: 0, uniques: 0, previews: 0, visits: 0 };
          const ownerLabel = share.organization?.slug || share.createdByUser?.handle || "personal";
          return {
            code: share.code,
            topic: share.topic ?? null,
            createdAt: share.createdAt.toISOString(),
            ownerLabel,
            views: metrics.views || 0,
            uniques: metrics.uniques || 0,
            previews: metrics.previews || 0,
            visits: metrics.visits || 0,
            previewRate: safePct(metrics.previews || 0, metrics.views || 0),
            ctr: safePct(metrics.visits || 0, metrics.views || 0),
          };
        })
        .filter((item: any) => item.views > 0 || item.visits > 0 || item.previews > 0)
        .sort((a: any, b: any) => b.visits - a.visits || b.views - a.views)
        .slice(0, 25);

      return {
        scope: scopeInfo.scope,
        label: scopeInfo.label,
        range: req.query.range,
        window: { start: window.start.toISOString(), endExclusive: window.endExclusive.toISOString() },
        totals: {
          views: currentViews.count,
          uniques: currentViews.uniques,
          previews: currentPreviews.count,
          visits: currentVisits.count,
          playStarts: currentStarts.count,
          playStops: currentStops.count,
          previewRate: safePct(currentPreviews.count, currentViews.count),
          visitRate: safePct(currentVisits.count, currentViews.count),
          visitPerPreviewRate: safePct(currentVisits.count, currentPreviews.count),
        },
        previousTotals: {
          views: previousViews.count,
          uniques: previousViews.uniques,
          previews: previousPreviews.count,
          visits: previousVisits.count,
        },
        trend: {
          viewsDeltaPct: safeDeltaPct(currentViews.count, previousViews.count),
          uniquesDeltaPct: safeDeltaPct(currentViews.uniques, previousViews.uniques),
          visitsDeltaPct: safeDeltaPct(currentVisits.count, previousVisits.count),
        },
        activeShares: topShares.length,
        series: seriesRows.map((row) => ({
          bucket: String(row.bucket),
          views: Number(row.views) || 0,
          visits: Number(row.visits) || 0,
          previews: Number(row.previews) || 0,
        })),
        topCampaigns: topCampaignRows.map((row) => ({
          campaign: String(row.campaign),
          views: Number(row.views) || 0,
          uniques: Number(row.uniques) || 0,
          visits: Number(row.visits) || 0,
        })),
        topTopics: topTopicRows.map((row) => ({
          topic: String(row.topic),
          views: Number(row.views) || 0,
          visits: Number(row.visits) || 0,
        })),
        topReferrers: topRefRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topCountries: topCountryRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topCities: topCityRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topDevices: topDeviceRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topBrowsers: topBrowserRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topOS: topOSRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topUrls: topUrlRows.map((row) => ({ url: String(row.url), visits: Number(row.visits) || 0 })),
        topSources: topSourceRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topMediums: topMediumRows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 })),
        topShares,
      };
    },
  );

  app.get<{ Querystring: z.infer<typeof AnalyticsOverviewQuerySchema>; Params: { code: string } }>(
    "/api/v1/analytics/v2/share/:code",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        querystring: AnalyticsOverviewQuerySchema,
        response: {
          200: z.object({
            code: z.string(),
            topic: z.string().nullable(),
            createdAt: z.string(),
            totals: z.object({
              views: z.number().int(),
              uniques: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
              previewRate: z.number(),
              ctr: z.number(),
            }),
            series: z.array(z.object({
              bucket: z.string(),
              views: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
            })),
            nodePerformance: z.array(z.object({
              nodeIndex: z.number().int(),
              previews: z.number().int(),
              visits: z.number().int(),
              visitPerPreviewRate: z.number(),
            })),
            topUrls: z.array(z.object({ url: z.string(), visits: z.number().int() })),
            attribution: z.object({
              campaigns: z.array(z.object({ label: z.string(), count: z.number().int() })),
              sources: z.array(z.object({ label: z.string(), count: z.number().int() })),
              mediums: z.array(z.object({ label: z.string(), count: z.number().int() })),
              referrers: z.array(z.object({ label: z.string(), count: z.number().int() })),
            }),
            geo: z.object({
              countries: z.array(z.object({ label: z.string(), count: z.number().int() })),
              cities: z.array(z.object({ label: z.string(), count: z.number().int() })),
            }),
            tech: z.object({
              devices: z.array(z.object({ label: z.string(), count: z.number().int() })),
              browsers: z.array(z.object({ label: z.string(), count: z.number().int() })),
              os: z.array(z.object({ label: z.string(), count: z.number().int() })),
            }),
          }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();

      const share = await prisma.share.findUnique({
        where: { code: req.params.code },
        include: { organization: true, createdByUser: true },
      });
      if (!share) return reply.code(404).send({ error: "not_found" });
      if (share.organizationId) {
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: share.organizationId } },
        });
        if (!membership) return reply.code(403).send({ error: "forbidden" });
      } else if (share.createdByUserId !== user.id) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const window = computeAnalyticsWindow(req.query.range, req.query.from, req.query.to);
      const params = [req.params.code, window.start.toISOString(), window.endExclusive.toISOString()];
      const totalsRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT
            SUM(CASE WHEN type='share_view' THEN 1 ELSE 0 END) as views,
            COUNT(DISTINCT CASE WHEN type='share_view' THEN viewerHash END) as uniques,
            SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews,
            SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode=? AND createdAt >= ? AND createdAt < ?`,
        ...params,
      );
      const totals = totalsRows?.[0] || {};

      const bucketExpr =
        window.bucket === "hour"
          ? `substr(createdAt, 1, 13) || ':00:00Z'`
          : `substr(createdAt, 1, 10)`;
      const seriesRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ${bucketExpr} as bucket,
                SUM(CASE WHEN type='share_view' THEN 1 ELSE 0 END) as views,
                SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews,
                SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode=? AND createdAt >= ? AND createdAt < ?
         GROUP BY ${bucketExpr}
         ORDER BY bucket ASC`,
        ...params,
      );
      const nodeRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT nodeIndex,
                SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews,
                SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode=? AND createdAt >= ? AND createdAt < ? AND nodeIndex IS NOT NULL
         GROUP BY nodeIndex
         ORDER BY nodeIndex ASC`,
        ...params,
      );
      const topUrlRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT url, COUNT(*) as visits
         FROM AnalyticsEvent
         WHERE shareCode=? AND type='node_visit' AND createdAt >= ? AND createdAt < ? AND url IS NOT NULL
         GROUP BY url
         ORDER BY visits DESC
         LIMIT 12`,
        ...params,
      );
      const mapBreakdown = async (column: string, fallback: string, eventType = "share_view") => {
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT COALESCE(NULLIF(${column},''), '${fallback}') as label, COUNT(*) as count
           FROM AnalyticsEvent
           WHERE shareCode=? AND type=? AND createdAt >= ? AND createdAt < ?
           GROUP BY COALESCE(NULLIF(${column},''), '${fallback}')
           ORDER BY count DESC
           LIMIT 12`,
          req.params.code,
          eventType,
          window.start.toISOString(),
          window.endExclusive.toISOString(),
        );
        return rows.map((row) => ({ label: String(row.label), count: Number(row.count) || 0 }));
      };

      return {
        code: req.params.code,
        topic: share.topic ?? null,
        createdAt: share.createdAt.toISOString(),
        totals: {
          views: Number(totals.views) || 0,
          uniques: Number(totals.uniques) || 0,
          previews: Number(totals.previews) || 0,
          visits: Number(totals.visits) || 0,
          previewRate: safePct(Number(totals.previews) || 0, Number(totals.views) || 0),
          ctr: safePct(Number(totals.visits) || 0, Number(totals.views) || 0),
        },
        series: seriesRows.map((row) => ({
          bucket: String(row.bucket),
          views: Number(row.views) || 0,
          previews: Number(row.previews) || 0,
          visits: Number(row.visits) || 0,
        })),
        nodePerformance: nodeRows.map((row) => ({
          nodeIndex: Number(row.nodeIndex) || 0,
          previews: Number(row.previews) || 0,
          visits: Number(row.visits) || 0,
          visitPerPreviewRate: safePct(Number(row.visits) || 0, Number(row.previews) || 0),
        })),
        topUrls: topUrlRows.map((row) => ({ url: String(row.url), visits: Number(row.visits) || 0 })),
        attribution: {
          campaigns: await mapBreakdown("utmCampaign", "(unattributed)"),
          sources: await mapBreakdown("utmSource", "(unknown)"),
          mediums: await mapBreakdown("utmMedium", "(unknown)"),
          referrers: await mapBreakdown("refererSource", "(direct)"),
        },
        geo: {
          countries: await mapBreakdown("country", "(unknown)"),
          cities: await mapBreakdown("city", "(unknown)"),
        },
        tech: {
          devices: await mapBreakdown("device", "(unknown)"),
          browsers: await mapBreakdown("browser", "(unknown)"),
          os: await mapBreakdown("os", "(unknown)"),
        },
      };
    },
  );

  app.get<{ Querystring: z.infer<typeof AnalyticsOverviewQuerySchema> }>(
    "/api/v1/analytics/v2/export.csv",
    {
      schema: {
        querystring: AnalyticsOverviewQuerySchema,
        response: {
          200: z.any(),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = await getPrisma();

      let scopeInfo;
      try {
        scopeInfo = await resolveAnalyticsScope(prisma, user, req.query.scope);
      } catch (err: any) {
        if (err?.code === "forbidden") return reply.code(403).send({ error: "forbidden" });
        throw err;
      }

      const codes = scopeInfo.shares.map((s: any) => s.code);
      if (codes.length === 0) {
        reply.type("text/csv; charset=utf-8");
        return "code,topic,createdAt,views,uniques,previews,visits,previewRate,ctr\r\n";
      }

      const window = computeAnalyticsWindow(req.query.range, req.query.from, req.query.to);
      const placeholders = codes.map(() => "?").join(",");
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT shareCode as code,
                SUM(CASE WHEN type='share_view' THEN 1 ELSE 0 END) as views,
                COUNT(DISTINCT CASE WHEN type='share_view' THEN viewerHash END) as uniques,
                SUM(CASE WHEN type='node_preview' THEN 1 ELSE 0 END) as previews,
                SUM(CASE WHEN type='node_visit' THEN 1 ELSE 0 END) as visits
         FROM AnalyticsEvent
         WHERE shareCode IN (${placeholders}) AND createdAt >= ? AND createdAt < ?
         GROUP BY shareCode`,
        ...codes,
        window.start.toISOString(),
        window.endExclusive.toISOString(),
      );
      const metrics = groupByCodeRows(rows, { views: "views", uniques: "uniques", previews: "previews", visits: "visits" });
      const csvRows = [
        ["code", "topic", "createdAt", "views", "uniques", "previews", "visits", "previewRate", "ctr"],
        ...scopeInfo.shares.map((share: any) => {
          const m = metrics[share.code] || { views: 0, uniques: 0, previews: 0, visits: 0 };
          return [
            share.code,
            share.topic ?? "",
            share.createdAt.toISOString(),
            String(m.views || 0),
            String(m.uniques || 0),
            String(m.previews || 0),
            String(m.visits || 0),
            String(safePct(m.previews || 0, m.views || 0)),
            String(safePct(m.visits || 0, m.views || 0)),
          ];
        }),
      ];
      const csv = csvRows
        .map((row) => row.map((value: string) => `"${String(value).replaceAll('"', '""')}"`).join(","))
        .join("\r\n");

      reply.header("content-disposition", `attachment; filename="cynode-analytics-${req.query.scope}-${req.query.range}.csv"`);
      reply.type("text/csv; charset=utf-8");
      return csv;
    },
  );

  app.post<{ Body: z.infer<typeof RegisterSchema> }>(
    "/api/v1/auth/register",
    {
      schema: {
        body: RegisterSchema,
        response: {
          201: z.object({
            user: z.object({
              id: z.string(),
              handle: z.string(),
              displayName: z.string().nullable(),
              avatarUrl: z.string().nullable(),
              email: z.string().nullable(),
            }),
          }),
          409: z.object({ error: z.literal("already_exists") }),
        },
      },
    },
    async (req, reply) => {
      const prisma = await getPrisma();
      const passwordHash = hashPassword(req.body.password);

      try {
        const created = await prisma.user.create({
          data: {
            handle: req.body.handle,
            email: req.body.email,
            displayName: req.body.displayName,
            passwordHash,
          },
        });

        await createSessionAndSetCookie(reply, req as any, created.id);
        
        // Attempt a short pull then push to synchronize accounts across devices.
        try {
          await awaitWithTimeout(pullUserWorkFromCloud(created.id), 3000);
        } catch (err) {
          console.warn("[Sync] Background Pull Error:", err);
        }
        try {
          await awaitWithTimeout(pushUserWorkToCloud(created.id), 3000);
        } catch (err) {
          console.warn("[Sync] Background Push Error:", err);
        }
        
        reply.code(201);
        return {
          user: {
            id: created.id,
            handle: created.handle,
            displayName: created.displayName ?? null,
            avatarUrl: created.avatarUrl ?? null,
            email: created.email ?? null,
          },
        };
      } catch (err: any) {
        if (typeof err?.code === "string" && err.code === "P2002") {
          return reply.code(409).send({ error: "already_exists" });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: z.infer<typeof LoginSchema> }>(
    "/api/v1/auth/login",
    {
      schema: {
        body: LoginSchema,
        response: {
          200: z.object({
            user: z.object({
              id: z.string(),
              handle: z.string(),
              displayName: z.string().nullable(),
              avatarUrl: z.string().nullable(),
              email: z.string().nullable(),
            }),
          }),
          401: z.object({ error: z.literal("invalid_credentials") }),
        },
      },
    },
    async (req, reply) => {
      const prisma = await getPrisma();
      const ident = req.body.identifier.trim().toLowerCase();
      let user =
        ident.includes("@")
          ? await prisma.user.findUnique({ where: { email: ident } })
          : await prisma.user.findUnique({ where: { handle: ident } });

      // If not found locally, try to find and pull from remote (Turso)
      if (!user) {
        const foundRemote = await findAndPullRemoteUser(ident);
        if (foundRemote) {
          user = ident.includes("@")
            ? await prisma.user.findUnique({ where: { email: ident } })
            : await prisma.user.findUnique({ where: { handle: ident } });
        }
      }

      if (!user || !user.passwordHash || !verifyPassword(req.body.password, user.passwordHash)) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      await createSessionAndSetCookie(reply, req as any, user.id);
      
      // Attempt a short pull then push to synchronize accounts across devices.
      try {
        await awaitWithTimeout(pullUserWorkFromCloud(user.id), 3000);
      } catch (err) {
        console.warn("[Sync] Background Pull Error:", err);
      }
      try {
        await awaitWithTimeout(pushUserWorkToCloud(user.id), 3000);
      } catch (err) {
        console.warn("[Sync] Background Push Error:", err);
      }
      return {
        user: {
          id: user.id,
          handle: user.handle,
          displayName: user.displayName ?? null,
          avatarUrl: user.avatarUrl ?? null,
          email: user.email ?? null,
        },
      };
    },
  );

  app.get(
    "/api/v1/me",
    {
      schema: {
        response: {
          200: z.object({
            user: z
              .object({
                id: z.string(),
                handle: z.string(),
                displayName: z.string().nullable(),
                avatarUrl: z.string().nullable(),
                email: z.string().nullable(),
              })
              .nullable(),
            userPlan: z
              .object({
                planKey: z.string(),
                status: z.string(),
              })
              .nullable(),
            organizations: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                role: z.string(),
                customDomain: z.string().nullable(),
                planKey: z.string(),
                planStatus: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const user = (req as any).user ?? null;
      if (!user) return { user: null, userPlan: null, organizations: [] };

      const prisma = await getPrisma();
      const userSub = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { organization: { include: { subscription: true } } },
        orderBy: { createdAt: "asc" },
      });
      return {
        user,
        userPlan: isUnlimitedUser(user)
          ? { planKey: "ultra", status: "active" }
          : { planKey: userSub?.planKey ?? "free", status: userSub?.status ?? "free" },
        organizations: memberships.map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          role: m.role,
          customDomain: m.organization.customDomain ?? null,
          planKey: m.organization.subscription?.planKey ?? "free",
          planStatus: m.organization.subscription?.status ?? "free",
        })),
      };
    },
  );

  const ProfileUpdateSchema = z.object({
    displayName: z.union([z.string().min(2).max(100), z.null()]).optional(),
    email: z.union([z.string().email().max(255), z.null()]).optional(),
    avatarUrl: z.union([z.string().url().max(2048), z.null()]).optional(),
  });

  const PasswordUpdateSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6).max(255),
  });

  app.patch<{ Body: z.infer<typeof ProfileUpdateSchema> }>(
    "/api/v1/user/profile",
    {
      schema: {
        body: ProfileUpdateSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.literal("unauthorized") }),
          409: z.object({ error: z.literal("email_already_taken") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();

      try {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            displayName: req.body.displayName,
            email: req.body.email,
            avatarUrl: req.body.avatarUrl,
          },
        });
        
        // Try a short push to cloud to surface profile changes to other devices.
        try {
          await awaitWithTimeout(pushUserWorkToCloud(user.id), 2000);
        } catch (err) {
          console.warn("[Sync] Profile update push failed:", err);
        }
        
        return { success: true };
      } catch (err: any) {
        if (typeof err?.code === "string" && err.code === "P2002") {
          return reply.code(409).send({ error: "email_already_taken" });
        }
        throw err;
      }
    }
  );

  app.patch<{ Body: z.infer<typeof PasswordUpdateSchema> }>(
    "/api/v1/user/password",
    {
      schema: {
        body: PasswordUpdateSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("invalid_current_password") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();

      // Get the current persistent user with passwordHash
      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!dbUser || !dbUser.passwordHash) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      if (!verifyPassword(req.body.currentPassword, dbUser.passwordHash)) {
        return reply.code(403).send({ error: "invalid_current_password" });
      }

      const newHash = hashPassword(req.body.newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });

      // Try a short push to cloud to propagate password change.
      try {
        await awaitWithTimeout(pushUserWorkToCloud(user.id), 2000);
      } catch (err) {
        console.warn("[Sync] Password update push failed:", err);
      }

      return { success: true };
    }
  );

  app.get(
    "/api/v1/auth/session-id",
    {
      schema: {
        response: {
          200: z.object({ sessionId: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const sid = req.cookies?.sid;
      return { sessionId: sid ?? null };
    },
  );

  app.post(
    "/api/v1/logout",
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
    },
    async (req, reply) => {
      await clearSessionCookieAndDb(req as any, reply);
      return { ok: true };
    },
  );

  // Offline sync queue endpoint: replay mutations that were queued when offline
  app.post(
    "/api/v1/sync/apply",
    {
      schema: {
        response: {
          200: z.object({ success: z.boolean(), queueId: z.number().optional() }),
          409: z.object({ error: z.literal("conflict"), data: z.any() }),
          401: z.object({ error: z.literal("unauthorized") }),
        },
      },
    },
    async (req: any, reply) => {
      const queueId = req.headers['x-sync-queue-id'];
      const user = req.user;
      
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const body = req.body;
      try {
        console.log('[Sync] Processing offline mutation:', { queueId, action: body?.action || 'unknown' });
        // Mutations are already handled by the existing API routes (/api/v1/graphs, /api/v1/saved, etc)
        // This endpoint just acknowledges receipt for the offline queue
        return {
          success: true,
          queueId: queueId ? parseInt(String(queueId), 10) : undefined,
        };
      } catch (err: any) {
        console.error("[Sync] Error applying queued mutation:", err);
        if (err.message && err.message.toLowerCase().includes("conflict")) {
          return reply.code(409).send({ error: "conflict", data: { reason: err.message } });
        }
        throw err;
      }
    }
  );

  app.post<{ Body: z.infer<typeof OrgCreateSchema> }>(
    "/api/v1/orgs",
    {
      schema: {
        body: OrgCreateSchema,
        response: {
          201: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            customDomain: z.string().nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const prisma = await getPrisma();
      const created = await prisma.organization.create({
        data: {
          name: req.body.name,
          slug: req.body.slug,
          customDomain: req.body.customDomain,
          createdByUserId: (req as any).user.id,
          memberships: { create: { userId: (req as any).user.id, role: "OWNER" } },
        },
      });
      reply.code(201);
      return { id: created.id, name: created.name, slug: created.slug, customDomain: created.customDomain ?? null };
    },
  );

  app.get(
    "/api/v1/orgs",
    {
      schema: {
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              slug: z.string(),
              customDomain: z.string().nullable(),
              role: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = (req as any).user ?? null;
      if (!user) return [];
      const prisma = await getPrisma();
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { organization: true },
        orderBy: { createdAt: "asc" },
      });
      return memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        customDomain: m.organization.customDomain ?? null,
        role: m.role,
      }));
    },
  );

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
    },
    async () => ({ ok: true }),
  );

  app.post<{
    Body?: {
      nodeCount?: number;
      lastSelectedNode?: number | null;
      nodeUrls?: Record<string, string>;
    };
  }>(
    "/api/v1/graphs",
    {
      schema: {
        body: z
          .object({
            nodeCount: z.number().int().min(1).max(20).optional(),
            lastSelectedNode: z.number().int().min(1).max(20).nullable().optional(),
            nodeUrls: NodeUrlsSchema.optional(),
            nodeCaptions: NodeCaptionsSchema.optional(),
            nodePauseSecByNode: z.record(z.string().regex(/^\d+$/), z.number()).optional(),
          })
          .optional(),
        response: {
          201: GraphSchema,
        },
      },
    },
    async (req, reply) => {
      const graph = await createGraph(req.body ?? undefined);
      reply.code(201);
      return graph;
    },
  );

  app.get<{ Params: { graphId: string } }>(
    "/api/v1/graphs/:graphId",
    {
      schema: {
        params: z.object({ graphId: z.string().uuid() }),
        response: {
          200: GraphSchema,
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const graph = await getGraph(req.params.graphId);
      if (!graph) return reply.code(404).send({ error: "not_found" });
      return graph;
    },
  );

  app.put<{
    Params: { graphId: string };
    Body: { nodeCount: number; lastSelectedNode: number | null; nodeUrls: Record<string, string> };
  }>(
    "/api/v1/graphs/:graphId",
    {
      schema: {
        params: z.object({ graphId: z.string().uuid() }),
        body: z.object({
          nodeCount: z.number().int().min(1).max(20),
          lastSelectedNode: z.number().int().min(1).max(20).nullable(),
          nodeUrls: NodeUrlsSchema,
          nodeCaptions: NodeCaptionsSchema.optional(),
          nodePauseSecByNode: z.record(z.string().regex(/^\d+$/), z.number()).optional(),
        }),
        response: {
          200: GraphSchema,
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const updated = await putGraph(req.params.graphId, req.body);
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return updated;
    },
  );

  // Create a short link (share code) for a snapshot of the current nodegraph state.
  app.post<{ Body: z.infer<typeof ShareCreateBodySchema> }>(
    "/api/v1/shares",
    {
      schema: {
        body: ShareCreateBodySchema,
        response: {
          201: ShareCreateResponseSchema,
          400: z.object({ error: z.literal("empty_graph") }),
          403: z.object({ error: z.literal("forbidden") }),
        },
      },
    },
    async (req, reply) => {
      // If a user is logged in, we persist ownership metadata. Anonymous usage remains supported.
      const user = (req as any).user ?? null;
      const orgId = req.body.organizationId ?? null;

      let org: { id: string; slug: string; customDomain: string | null } | null = null;
      if (orgId) {
        requireUser(req as any);
        const prisma = await getPrisma();
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
          include: { organization: true },
        });
        if (!membership) return reply.code(403).send({ error: "forbidden" });
        org = {
          id: membership.organization.id,
          slug: membership.organization.slug,
          customDomain: membership.organization.customDomain ?? null,
        };
      }

      const compacted = compactGraphStateForPersistence(req.body);
      if (!compacted) return reply.code(400).send({ error: "empty_graph" });

      const share = await createShareFromGraphState(compacted, {
        createdByUserId: user?.id ?? null,
        organizationId: orgId,
        saved: false,
        topic: req.body.topic ?? null,
      });

      // Attempt a short background push so newly-created shares become available across devices.
      if (user) {
        try {
          await awaitWithTimeout(pushUserWorkToCloud(user.id), 2000);
        } catch (err) {
          console.warn("[Sync] Share-create background push failed:", (err as any)?.message ?? err);
        }
      }

      const baseUrl = getBaseUrl(req);
      const proto = getProto(req);

      let shareUrl: string;
      if (org?.customDomain) {
        shareUrl = `${proto}://${org.customDomain}/${share.code}`;
      } else if (org) {
        shareUrl = `${baseUrl}/${org.slug}/${share.code}`;
      } else if (user) {
        shareUrl = `${baseUrl}/${user.handle}/${share.code}`;
      } else {
        shareUrl = `${baseUrl}/s/${share.code}`;
      }

      reply.code(201);
      return {
        code: share.code,
        shareUrl,
        graphId: share.graphId,
        createdAt: share.createdAt,
        topic: share.topic ?? null,
      };
    }
  );

  // Save a nodegraph state to the signed-in user's account and return a branded short link.
  app.post<{ Body: z.infer<typeof ShareCreateBodySchema> }>(
    "/api/v1/saved",
    {
      schema: {
        body: ShareCreateBodySchema,
        response: {
          201: ShareCreateResponseSchema,
          401: z.object({ error: z.literal("unauthorized") }),
          400: z.object({ error: z.literal("empty_graph") }),
          403: z.object({ error: z.literal("forbidden") }),
          402: z.object({ error: z.literal("quota_exceeded") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const orgId = req.body.organizationId ?? null;

      let owner: { type: "user"; handle: string } | { type: "org"; slug: string; customDomain: string | null } = {
        type: "user",
        handle: user.handle,
      };

      if (orgId) {
        const prisma = await getPrisma();
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
          include: { organization: { include: { subscription: true } } },
        });
        if (!membership) return reply.code(403).send({ error: "forbidden" });
        owner = {
          type: "org",
          slug: membership.organization.slug,
          customDomain: membership.organization.customDomain ?? null,
        };

        // Quota enforcement (org-scoped) for non-unlimited users.
        if (!isUnlimitedUser(user)) {
          const plan = planByKey(membership.organization.subscription?.planKey ?? "free");
          if (plan.monthlyCredits !== null) {
            const periodStart = monthPeriodStart(new Date());
            const prisma2 = await getPrisma();
            const counter = await prisma2.usageCounter.findUnique({
              where: { subjectType_subjectId_periodStart: { subjectType: "org", subjectId: orgId, periodStart } },
            });
            const nextCredits = (counter?.creditsUsed ?? 0) + creditsForSavedLink();
            const nextSaved = (counter?.savedLinksCreated ?? 0) + 1;
            if (
              (plan.monthlyCredits !== null && nextCredits > plan.monthlyCredits) ||
              (plan.maxSavedLinksPerMonth !== null && nextSaved > plan.maxSavedLinksPerMonth)
            ) {
              return reply.code(402).send({ error: "quota_exceeded" });
            }
          }
        }
      }

      // Personal quota enforcement for non-unlimited users.
      if (!orgId && !isUnlimitedUser(user)) {
        const prisma = await getPrisma();
        const sub = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
        const plan = planByKey(sub?.planKey ?? "free");
        if (plan.monthlyCredits !== null) {
          const periodStart = monthPeriodStart(new Date());
          const counter = await prisma.usageCounter.findUnique({
            where: { subjectType_subjectId_periodStart: { subjectType: "user", subjectId: user.id, periodStart } },
          });
          const nextCredits = (counter?.creditsUsed ?? 0) + creditsForSavedLink();
          const nextSaved = (counter?.savedLinksCreated ?? 0) + 1;
          if (
            (plan.monthlyCredits !== null && nextCredits > plan.monthlyCredits) ||
            (plan.maxSavedLinksPerMonth !== null && nextSaved > plan.maxSavedLinksPerMonth)
          ) {
            return reply.code(402).send({ error: "quota_exceeded" });
          }
        }
      }

      const compacted = compactGraphStateForPersistence(req.body);
      if (!compacted) return reply.code(400).send({ error: "empty_graph" });

      const share = await createShareFromGraphState(compacted, {
        createdByUserId: user.id,
        organizationId: orgId,
        saved: true,
        topic: req.body.topic ?? null,
      });

      // Usage accounting (best-effort).
      try {
        if (orgId) await addUsage("org", orgId, { creditsUsed: creditsForSavedLink(), savedLinksCreated: 1 });
        else await addUsage("user", user.id, { creditsUsed: creditsForSavedLink(), savedLinksCreated: 1 });
      } catch (_) { }
      const baseUrl = getBaseUrl(req);

      reply.code(201);
      return {
        code: share.code,
        shareUrl: formatShareUrlForOwner(baseUrl, req, owner, share.code),
        graphId: share.graphId,
        createdAt: share.createdAt,
        topic: share.topic ?? null,
      };
    },
  );

  // List saved node sets for the signed-in user.
  app.get(
    "/api/v1/saved",
    {
      schema: {
        response: {
          200: SavedListSchema,
          401: z.object({ error: z.literal("unauthorized") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const prisma = await getPrisma();
      const items = await prisma.share.findMany({
        where: { createdByUserId: user.id, saved: true },
        include: { organization: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });

      const baseUrl = getBaseUrl(req);
      return items.map((s) => ({
        code: s.code,
        shareUrl: formatShareUrlForOwner(
          baseUrl,
          req,
          s.organization
            ? { type: "org", slug: s.organization.slug, customDomain: s.organization.customDomain ?? null }
            : { type: "user", handle: user.handle },
          s.code,
        ),
        createdAt: s.createdAt.toISOString(),
        namespace: s.organization ? s.organization.slug : user.handle,
        topic: s.topic ?? null,
      }));
    },
  );

  // Remove a saved link from the user's panel (does not invalidate the share code).
  app.delete<{ Params: { code: string } }>(
    "/api/v1/saved/:code",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: z.object({ error: z.literal("unauthorized") }),
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const user = (req as any).user ?? null;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const prisma = await getPrisma();
      const existing = await prisma.share.findUnique({ where: { code: req.params.code } });
      if (!existing || existing.createdByUserId !== user.id || existing.saved !== true) {
        return reply.code(404).send({ error: "not_found" });
      }

      await prisma.share.update({
        where: { code: req.params.code },
        data: { saved: false },
      });

      return { ok: true };
    },
  );

  app.put<{ Params: { code: string }; Body: z.infer<typeof ShareCreateBodySchema> }>(
    "/api/v1/saved/:code",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        body: ShareCreateBodySchema,
        response: {
          200: ShareCreateResponseSchema,
          401: z.object({ error: z.literal("unauthorized") }),
          400: z.object({ error: z.literal("empty_graph") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();
      const authz = await assertCanEditSavedShare(prisma, user, req.params.code);
      if (authz.error === "not_found") return reply.code(404).send({ error: "not_found" });
      if (authz.error) return reply.code(403).send({ error: "forbidden" });

      const compacted = compactGraphStateForPersistence(req.body);
      if (!compacted) return reply.code(400).send({ error: "empty_graph" });

      const prevGraphId = authz.share.graphId;
      const nextGraph = await createGraph(compacted);

      const updated = await prisma.share.update({
        where: { code: req.params.code },
        data: {
          graphId: nextGraph.id,
          topic: req.body.topic ?? null,
        },
        include: { organization: true },
      });

      try {
        await prisma.graph.delete({ where: { id: prevGraphId } });
      } catch (_) { }

      const baseUrl = getBaseUrl(req);
      const owner = updated.organization
        ? { type: "org" as const, slug: updated.organization.slug, customDomain: updated.organization.customDomain ?? null }
        : { type: "user" as const, handle: user.handle };

      return {
        code: updated.code,
        shareUrl: formatShareUrlForOwner(baseUrl, req, owner, updated.code),
        graphId: updated.graphId,
        createdAt: updated.createdAt.toISOString(),
        topic: updated.topic ?? null,
      };
    },
  );

  // Upload background audio for a saved node set (persisted with the share code).
  app.post<{ Params: { code: string } }>(
    "/api/v1/saved/:code/media/background",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        response: {
          201: z.object({
            id: z.string(),
            url: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number().int(),
          }),
          400: z.object({ error: z.literal("invalid_file") }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
          402: z.object({ error: z.literal("quota_exceeded") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();

      const authz = await assertCanEditSavedShare(prisma, user, req.params.code);
      if (authz.error === "not_found") return reply.code(404).send({ error: "not_found" });
      if (authz.error === "forbidden") return reply.code(403).send({ error: "forbidden" });

      const file = await (req as any).file();
      if (!file || typeof file.mimetype !== "string" || !file.mimetype.startsWith("audio/")) {
        return reply.code(400).send({ error: "invalid_file" });
      }

      const existing = await prisma.mediaAsset.findUnique({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "bg", nodeIndex: 0 } },
      });
      const stored = await storeMultipartAudio(file, existing?.id);

      // Quota enforcement after knowing size (best-effort).
      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId && !isUnlimitedUser(user)) {
          const prisma2 = await getPrisma();
          const planKey = authz.share.organizationId
            ? authz.share.organization?.subscription?.planKey ?? "free"
            : (await prisma2.userSubscription.findUnique({ where: { userId: user.id } }))?.planKey ?? "free";
          const plan = planByKey(planKey);
          const unlimited = plan.key === "ultra";
          if (!unlimited && plan.monthlyCredits !== null) {
            const periodStart = monthPeriodStart(new Date());
            const counter = await prisma2.usageCounter.findUnique({
              where: { subjectType_subjectId_periodStart: { subjectType, subjectId, periodStart } },
            });
            const deltaCredits = creditsForMediaBytes(stored.sizeBytes);
            const nextCredits = (counter?.creditsUsed ?? 0) + deltaCredits;
            const nextBytes = (counter?.mediaBytesUploaded ?? 0) + stored.sizeBytes;
            const maxBytes =
              plan.maxMediaMBPerMonth === null ? null : Math.max(0, plan.maxMediaMBPerMonth) * 1024 * 1024;
            if ((plan.monthlyCredits !== null && nextCredits > plan.monthlyCredits) || (maxBytes !== null && nextBytes > maxBytes)) {
              await deleteStoredMedia(stored.storagePath);
              return reply.code(402).send({ error: "quota_exceeded" });
            }
          }
        }
      } catch (_) { }
      if (existing && existing.storagePath !== stored.storagePath) await deleteStoredMedia(existing.storagePath);

      const created = await prisma.mediaAsset.upsert({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "bg", nodeIndex: 0 } },
        create: {
          id: stored.id,
          shareCode: req.params.code,
          kind: "bg",
          nodeIndex: 0,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
        update: {
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
      });

      reply.code(201);

      // Usage accounting (best-effort).
      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId) {
          await addUsage(subjectType, subjectId, {
            creditsUsed: creditsForMediaBytes(stored.sizeBytes),
            mediaBytesUploaded: stored.sizeBytes,
          });
        }
      } catch (_) { }
      return {
        id: created.id,
        url: buildAppUrl(req, `/m/${created.id}`),
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
      };
    },
  );

  // Upload a voice annotation for a specific node in a saved node set.
  app.post<{ Params: { code: string; nodeIndex: string } }>(
    "/api/v1/saved/:code/media/voice/:nodeIndex",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema, nodeIndex: z.string().regex(/^\d+$/) }),
        response: {
          201: z.object({
            id: z.string(),
            url: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number().int(),
            nodeIndex: z.number().int(),
          }),
          400: z.object({ error: z.union([z.literal("invalid_file"), z.literal("invalid_node")]) }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
          402: z.object({ error: z.literal("quota_exceeded") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();

      const nodeIndex = Number(req.params.nodeIndex);
      if (!Number.isFinite(nodeIndex) || nodeIndex < 1 || nodeIndex > 20) {
        return reply.code(400).send({ error: "invalid_node" });
      }

      const authz = await assertCanEditSavedShare(prisma, user, req.params.code);
      if (authz.error === "not_found") return reply.code(404).send({ error: "not_found" });
      if (authz.error === "forbidden") return reply.code(403).send({ error: "forbidden" });

      const file = await (req as any).file();
      if (!file || typeof file.mimetype !== "string" || !file.mimetype.startsWith("audio/")) {
        return reply.code(400).send({ error: "invalid_file" });
      }

      const existing = await prisma.mediaAsset.findUnique({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "voice", nodeIndex } },
      });
      const stored = await storeMultipartAudio(file, existing?.id);

      // Quota enforcement after knowing size (best-effort).
      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId && !isUnlimitedUser(user)) {
          const prisma2 = await getPrisma();
          const planKey = authz.share.organizationId
            ? authz.share.organization?.subscription?.planKey ?? "free"
            : (await prisma2.userSubscription.findUnique({ where: { userId: user.id } }))?.planKey ?? "free";
          const plan = planByKey(planKey);
          const unlimited = plan.key === "ultra";
          if (!unlimited && plan.monthlyCredits !== null) {
            const periodStart = monthPeriodStart(new Date());
            const counter = await prisma2.usageCounter.findUnique({
              where: { subjectType_subjectId_periodStart: { subjectType, subjectId, periodStart } },
            });
            const deltaCredits = creditsForMediaBytes(stored.sizeBytes);
            const nextCredits = (counter?.creditsUsed ?? 0) + deltaCredits;
            const nextBytes = (counter?.mediaBytesUploaded ?? 0) + stored.sizeBytes;
            const maxBytes =
              plan.maxMediaMBPerMonth === null ? null : Math.max(0, plan.maxMediaMBPerMonth) * 1024 * 1024;
            if ((plan.monthlyCredits !== null && nextCredits > plan.monthlyCredits) || (maxBytes !== null && nextBytes > maxBytes)) {
              await deleteStoredMedia(stored.storagePath);
              return reply.code(402).send({ error: "quota_exceeded" });
            }
          }
        }
      } catch (_) { }
      if (existing && existing.storagePath !== stored.storagePath) await deleteStoredMedia(existing.storagePath);

      const created = await prisma.mediaAsset.upsert({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "voice", nodeIndex } },
        create: {
          id: stored.id,
          shareCode: req.params.code,
          kind: "voice",
          nodeIndex,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
        update: {
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
      });

      reply.code(201);

      // Usage accounting (best-effort).
      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId) {
          await addUsage(subjectType, subjectId, {
            creditsUsed: creditsForMediaBytes(stored.sizeBytes),
            mediaBytesUploaded: stored.sizeBytes,
          });
        }
      } catch (_) { }
      return {
        id: created.id,
        url: buildAppUrl(req, `/m/${created.id}`),
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        nodeIndex,
      };
    },
  );

  // Upload a local file for a specific node in a saved node set.
  app.post<{ Params: { code: string; nodeIndex: string } }>(
    "/api/v1/saved/:code/media/node/:nodeIndex",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema, nodeIndex: z.string().regex(/^\d+$/) }),
        response: {
          201: z.object({
            id: z.string(),
            url: z.string(),
            mimeType: z.string(),
            sizeBytes: z.number().int(),
            nodeIndex: z.number().int(),
          }),
          400: z.object({ error: z.union([z.literal("invalid_node"), z.literal("invalid_file")]) }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
          402: z.object({ error: z.literal("quota_exceeded") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req as any);
      const user = (req as any).user;
      const prisma = await getPrisma();

      const nodeIndex = Number(req.params.nodeIndex);
      if (!Number.isFinite(nodeIndex) || nodeIndex < 1 || nodeIndex > 20) {
        return reply.code(400).send({ error: "invalid_node" });
      }

      const authz = await assertCanEditSavedShare(prisma, user, req.params.code);
      if (authz.error === "not_found") return reply.code(404).send({ error: "not_found" });
      if (authz.error === "forbidden") return reply.code(403).send({ error: "forbidden" });

      const file = await (req as any).file();
      if (!file) return reply.code(400).send({ error: "invalid_file" });

      const existing = await prisma.mediaAsset.findUnique({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "node_file", nodeIndex } },
      });
      const stored = await storeMultipartAudio(file, existing?.id);

      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId && !isUnlimitedUser(user)) {
          const prisma2 = await getPrisma();
          const planKey = authz.share.organizationId
            ? authz.share.organization?.subscription?.planKey ?? "free"
            : (await prisma2.userSubscription.findUnique({ where: { userId: user.id } }))?.planKey ?? "free";
          const plan = planByKey(planKey);
          const unlimited = plan.key === "ultra";
          if (!unlimited && plan.monthlyCredits !== null) {
            const periodStart = monthPeriodStart(new Date());
            const counter = await prisma2.usageCounter.findUnique({
              where: { subjectType_subjectId_periodStart: { subjectType, subjectId, periodStart } },
            });
            const deltaCredits = creditsForMediaBytes(stored.sizeBytes);
            const nextCredits = (counter?.creditsUsed ?? 0) + deltaCredits;
            const nextBytes = (counter?.mediaBytesUploaded ?? 0) + stored.sizeBytes;
            const maxBytes = plan.maxMediaMBPerMonth === null ? null : Math.max(0, plan.maxMediaMBPerMonth) * 1024 * 1024;
            if ((plan.monthlyCredits !== null && nextCredits > plan.monthlyCredits) || (maxBytes !== null && nextBytes > maxBytes)) {
              await deleteStoredMedia(stored.storagePath);
              return reply.code(402).send({ error: "quota_exceeded" });
            }
          }
        }
      } catch (_) { }
      if (existing && existing.storagePath !== stored.storagePath) await deleteStoredMedia(existing.storagePath);

      const created = await prisma.mediaAsset.upsert({
        where: { shareCode_kind_nodeIndex: { shareCode: req.params.code, kind: "node_file", nodeIndex } },
        create: {
          id: stored.id,
          shareCode: req.params.code,
          kind: "node_file",
          nodeIndex,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
        update: {
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          originalName: stored.originalName,
          storagePath: stored.storagePath,
        },
      });

      reply.code(201);
      try {
        const subjectType = authz.share.organizationId ? "org" : "user";
        const subjectId = authz.share.organizationId ?? authz.share.createdByUserId;
        if (subjectId) {
          await addUsage(subjectType, subjectId, {
            creditsUsed: creditsForMediaBytes(stored.sizeBytes),
            mediaBytesUploaded: stored.sizeBytes,
          });
        }
      } catch (_) { }
      return {
        id: created.id,
        url: buildAppUrl(req, `/m/${created.id}`),
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        nodeIndex,
      };
    },
  );

  // Resolve a share code into the snapshot graph state.
  app.get<{ Params: { code: string } }>(
    "/api/v1/shares/:code",
    {
      schema: {
        params: z.object({ code: ShareCodeSchema }),
        response: {
          200: GraphWithTopicSchema,
          404: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    async (req, reply) => {
      const resolved = await getGraphByShareCode(req.params.code);
      if (!resolved) return reply.code(404).send({ error: "not_found" });
      const { shareCreatedAt: _shareCreatedAt, ...graph } = resolved;

      // Attach media descriptors if present.
      try {
        const prisma = await getPrisma();
        const media = await prisma.mediaAsset.findMany({ where: { shareCode: req.params.code } });
        const background = media.find((m: any) => m.kind === "bg" && m.nodeIndex === 0) ?? null;
        const voiceByNode: Record<string, any> = {};
        const filesByNode: Record<string, any> = {};
        for (const m of media) {
          if (m.kind === "voice" && m.nodeIndex >= 1) {
            voiceByNode[String(m.nodeIndex)] = {
              id: m.id,
              url: buildAppUrl(req, `/m/${m.id}`),
              mimeType: m.mimeType,
              sizeBytes: m.sizeBytes,
            };
          } else if (m.kind === "node_file" && m.nodeIndex >= 1) {
            filesByNode[String(m.nodeIndex)] = {
              id: m.id,
              url: buildAppUrl(req, `/m/${m.id}`),
              mimeType: m.mimeType,
              sizeBytes: m.sizeBytes,
            };
          }
        }
        return {
          ...graph,
          media: {
            background: background
              ? { id: background.id, url: buildAppUrl(req, `/m/${background.id}`), mimeType: background.mimeType, sizeBytes: background.sizeBytes }
              : null,
            voiceByNode,
            filesByNode,
          },
        };
      } catch (_) {
        return graph;
      }
    },
  );
}
