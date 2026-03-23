import { z } from "zod/v4";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { getPrisma } from "./db.js";
import { requireUser } from "./auth.js";
import { buildAppUrl, getPublicOrigin, normalizeAppPath } from "./origin.js";

type Plan = {
  key: string;
  name: string;
  priceId: string | null;
  description: string;
};

function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  return new Stripe(key, { typescript: true });
}

function plans(): Plan[] {
  const pricePro = process.env.STRIPE_PRICE_PRO ?? process.env.STRIPE_PRICE_STARTER ?? null;
  const priceUltra = process.env.STRIPE_PRICE_ULTRA ?? process.env.STRIPE_PRICE_TEAM ?? null;
  return [
    { key: "free", name: "Free", priceId: null, description: "Personal + basic sharing" },
    { key: "pro", name: "Pro", priceId: pricePro, description: "Power users and small teams" },
    { key: "ultra", name: "Ultra", priceId: priceUltra, description: "Organizations and heavy usage" },
  ];
}

function getBaseUrl(req: Parameters<typeof getPublicOrigin>[0]): string {
  return getPublicOrigin(req);
}

async function requireOrgOwner(userId: string, organizationId: string) {
  const prisma = getPrisma();
  const m = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });
  if (!m || String(m.role).toUpperCase() !== "OWNER") {
    const err: any = new Error("forbidden");
    err.statusCode = 403;
    throw err;
  }
}

function planKeyFromPriceId(priceId: string | null | undefined): string {
  const map = new Map<string, string>();
  for (const p of plans()) {
    if (p.priceId) map.set(p.priceId, p.key);
  }
  if (!priceId) return "free";
  return map.get(priceId) ?? "free";
}

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/billing/plans",
    {
      schema: {
        response: {
          200: z.array(
            z.object({
              key: z.string(),
              name: z.string(),
              description: z.string(),
              provider: z.literal("stripe").nullable(),
              available: z.boolean(),
            }),
          ),
        },
      },
    },
    async () => {
      const enabled = stripeEnabled();
      return plans().map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        provider: p.key === "free" ? null : "stripe",
        available: p.key === "free" ? true : enabled && !!p.priceId,
      }));
    },
  );

  app.get<{ Params: { orgId: string } }>(
    "/api/v1/billing/org/:orgId",
    {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        response: {
          200: z.object({
            orgId: z.string(),
            planKey: z.string(),
            status: z.string(),
            currentPeriodEnd: z.string().nullable(),
            cancelAtPeriodEnd: z.boolean(),
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
      await requireOrgOwner(user.id, req.params.orgId);

      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: req.params.orgId } });
      if (!org) return reply.code(404).send({ error: "not_found" });

      const sub = await prisma.subscription.findUnique({ where: { organizationId: org.id } });
      if (!sub) {
        return {
          orgId: org.id,
          planKey: "free",
          status: "free",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        };
      }
      return {
        orgId: org.id,
        planKey: sub.planKey,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
      };
    },
  );

  app.post<{ Params: { orgId: string }; Body: { planKey: string; successPath?: string; cancelPath?: string } }>(
    "/api/v1/billing/org/:orgId/checkout",
    {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({
          planKey: z.string(),
          successPath: z.string().regex(/^\/(?!\/).*/).optional(),
          cancelPath: z.string().regex(/^\/(?!\/).*/).optional(),
        }),
        response: {
          201: z.object({ url: z.string() }),
          400: z.object({ error: z.literal("invalid_plan") }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
          501: z.object({ error: z.literal("stripe_not_configured") }),
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      await requireOrgOwner(user.id, req.params.orgId);

      const prisma = getPrisma();
      const org = await prisma.organization.findUnique({ where: { id: req.params.orgId } });
      if (!org) return reply.code(404).send({ error: "not_found" });

      const plan = plans().find((p) => p.key === req.body.planKey) ?? null;
      if (!plan) return reply.code(400).send({ error: "invalid_plan" });
      if (plan.key === "free") {
        await prisma.subscription.upsert({
          where: { organizationId: org.id },
          create: { organizationId: org.id, provider: "stripe", planKey: "free", status: "free" },
          update: { planKey: "free", status: "free", providerSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
        });
        return reply.code(201).send({ url: buildAppUrl(req, "/?billing=free") });
      }

      if (!stripeEnabled() || !plan.priceId) return reply.code(501).send({ error: "stripe_not_configured" });

      const stripe = getStripe();
      const successUrl = buildAppUrl(req, normalizeAppPath(req.body.successPath, "/?billing=success"));
      const cancelUrl = buildAppUrl(req, normalizeAppPath(req.body.cancelPath, "/?billing=cancel"));

      const existing = await prisma.subscription.findUnique({ where: { organizationId: org.id } });
      let customerId = existing?.providerCustomerId ?? null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: org.name,
          metadata: { organizationId: org.id },
        });
        customerId = customer.id;
        await prisma.subscription.upsert({
          where: { organizationId: org.id },
          create: { organizationId: org.id, provider: "stripe", planKey: "free", status: "free", providerCustomerId: customerId },
          update: { providerCustomerId: customerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: org.id,
        metadata: { organizationId: org.id, planKey: plan.key },
        subscription_data: { metadata: { organizationId: org.id, planKey: plan.key } },
      });

      if (!session.url) return reply.code(501).send({ error: "stripe_not_configured" });
      reply.code(201);
      return { url: session.url };
    },
  );

  // Personal billing status (signed-in user).
  app.get(
    "/api/v1/billing/me",
    {
      schema: {
        response: {
          200: z.object({
            planKey: z.string(),
            status: z.string(),
            currentPeriodEnd: z.string().nullable(),
            cancelAtPeriodEnd: z.boolean(),
          }),
          401: z.object({ error: z.literal("unauthorized") }),
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const prisma = getPrisma();
      const sub = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
      if (!sub) {
        return { planKey: "free", status: "free", currentPeriodEnd: null, cancelAtPeriodEnd: false };
      }
      return {
        planKey: sub.planKey,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
      };
    },
  );

  // Personal checkout (Stripe subscription).
  app.post<{ Body: { planKey: string; successPath?: string; cancelPath?: string } }>(
    "/api/v1/billing/me/checkout",
    {
      schema: {
        body: z.object({
          planKey: z.string(),
          successPath: z.string().regex(/^\/(?!\/).*/).optional(),
          cancelPath: z.string().regex(/^\/(?!\/).*/).optional(),
        }),
        response: {
          201: z.object({ url: z.string() }),
          400: z.object({ error: z.literal("invalid_plan") }),
          401: z.object({ error: z.literal("unauthorized") }),
          501: z.object({ error: z.literal("stripe_not_configured") }),
        },
      },
    },
    async (req, reply) => {
      requireUser(req);
      const user = req.user;

      const plan = plans().find((p) => p.key === req.body.planKey) ?? null;
      if (!plan) return reply.code(400).send({ error: "invalid_plan" });

      const prisma = getPrisma();
      if (plan.key === "free") {
        await prisma.userSubscription.upsert({
          where: { userId: user.id },
          create: { userId: user.id, provider: "stripe", planKey: "free", status: "free" },
          update: { planKey: "free", status: "free", providerSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
        });
        reply.code(201);
        return { url: buildAppUrl(req, "/pricing?billing=free") };
      }

      if (!stripeEnabled() || !plan.priceId) return reply.code(501).send({ error: "stripe_not_configured" });
      const stripe = getStripe();
      const successUrl = buildAppUrl(req, normalizeAppPath(req.body.successPath, "/pricing?billing=success"));
      const cancelUrl = buildAppUrl(req, normalizeAppPath(req.body.cancelPath, "/pricing?billing=cancel"));

      const existing = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
      let customerId = existing?.providerCustomerId ?? null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email ?? undefined,
          name: user.handle,
          metadata: { userId: user.id },
        });
        customerId = customer.id;
        await prisma.userSubscription.upsert({
          where: { userId: user.id },
          create: { userId: user.id, provider: "stripe", planKey: "free", status: "free", providerCustomerId: customerId },
          update: { providerCustomerId: customerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: user.id,
        metadata: { userId: user.id, planKey: plan.key },
        subscription_data: { metadata: { userId: user.id, planKey: plan.key } },
      });

      reply.code(201);
      return { url: session.url! };
    },
  );

  app.post(
    "/api/v1/billing/me/portal",
    {
      schema: {
        response: {
          201: z.object({ url: z.string() }),
          401: z.object({ error: z.literal("unauthorized") }),
          404: z.object({ error: z.literal("not_found") }),
          501: z.object({ error: z.literal("stripe_not_configured") }),
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      if (!stripeEnabled()) return reply.code(501).send({ error: "stripe_not_configured" });

      const prisma = getPrisma();
      const sub = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
      if (!sub || !sub.providerCustomerId) return reply.code(404).send({ error: "not_found" });

      const stripe = getStripe();
      const portal = await stripe.billingPortal.sessions.create({
        customer: sub.providerCustomerId,
        return_url: buildAppUrl(req, "/pricing"),
      });
      reply.code(201);
      return { url: portal.url };
    },
  );

  app.post<{ Params: { orgId: string } }>(
    "/api/v1/billing/org/:orgId/portal",
    {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        response: {
          201: z.object({ url: z.string() }),
          401: z.object({ error: z.literal("unauthorized") }),
          403: z.object({ error: z.literal("forbidden") }),
          404: z.object({ error: z.literal("not_found") }),
          501: z.object({ error: z.literal("stripe_not_configured") }),
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      await requireOrgOwner(user.id, req.params.orgId);

      if (!stripeEnabled()) return reply.code(501).send({ error: "stripe_not_configured" });
      const prisma = getPrisma();
      const sub = await prisma.subscription.findUnique({ where: { organizationId: req.params.orgId } });
      if (!sub || !sub.providerCustomerId) return reply.code(404).send({ error: "not_found" });

      const stripe = getStripe();
      const portal = await stripe.billingPortal.sessions.create({
        customer: sub.providerCustomerId,
        return_url: buildAppUrl(req, "/"),
      });
      reply.code(201);
      return { url: portal.url };
    },
  );

  // Stripe webhook (raw body required). Configure STRIPE_WEBHOOK_SECRET.
  app.post(
    "/api/v1/billing/stripe/webhook",
    {
      config: { rawBody: true },
      schema: {
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: z.object({ error: z.literal("bad_signature") }),
          501: z.object({ error: z.literal("stripe_not_configured") }),
        },
      },
    },
    async (req, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripeEnabled() || !secret) return reply.code(501).send({ error: "stripe_not_configured" });

      const stripe = getStripe();
      const sig = req.headers["stripe-signature"];
      if (typeof sig !== "string") return reply.code(400).send({ error: "bad_signature" });

      let event: Stripe.Event;
      try {
        // fastify-raw-body provides req.rawBody
        const raw = req.rawBody;
        if (typeof raw !== "string") return reply.code(400).send({ error: "bad_signature" });
        event = stripe.webhooks.constructEvent(raw, sig, secret);
      } catch (_) {
        return reply.code(400).send({ error: "bad_signature" });
      }

      const prisma = getPrisma();

      const upsertFromStripeSubscription = async (orgId: string, sub: Stripe.Subscription) => {
        const priceId = sub.items.data[0]?.price?.id ?? null;
        const planKey = planKeyFromPriceId(priceId);
        const status = sub.status ?? "unknown";
        // Stripe v20 types expose current period boundaries on subscription items.
        const periodEndSec = Math.max(
          0,
          ...sub.items.data
            .map((it: any) => Number(it.current_period_end) || 0)
            .filter((n: number) => Number.isFinite(n) && n > 0),
        );
        const currentPeriodEnd = periodEndSec > 0 ? new Date(periodEndSec * 1000) : null;
        const cancelAtPeriodEnd = sub.cancel_at_period_end === true;
        await prisma.subscription.upsert({
          where: { organizationId: orgId },
          create: {
            organizationId: orgId,
            provider: "stripe",
            planKey,
            status,
            providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
            providerSubscriptionId: sub.id,
            currentPeriodEnd,
            cancelAtPeriodEnd,
          },
          update: {
            provider: "stripe",
            planKey,
            status,
            providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
            providerSubscriptionId: sub.id,
            currentPeriodEnd,
            cancelAtPeriodEnd,
          },
        });
      };

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = (session.metadata && (session.metadata as any).organizationId) || null;
        const userId = (session.metadata && (session.metadata as any).userId) || null;
        const subId = session.subscription;
        if (typeof orgId === "string" && typeof subId === "string") {
          const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
          await upsertFromStripeSubscription(orgId, sub);
        }
        if (typeof userId === "string" && typeof subId === "string") {
          const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
          const priceId = sub.items.data[0]?.price?.id ?? null;
          const planKey = planKeyFromPriceId(priceId);
          const status = sub.status ?? "unknown";
          const periodEndSec = Math.max(
            0,
            ...sub.items.data
              .map((it: any) => Number(it.current_period_end) || 0)
              .filter((n: number) => Number.isFinite(n) && n > 0),
          );
          const currentPeriodEnd = periodEndSec > 0 ? new Date(periodEndSec * 1000) : null;
          const cancelAtPeriodEnd = sub.cancel_at_period_end === true;

          await prisma.userSubscription.upsert({
            where: { userId },
            create: {
              userId,
              provider: "stripe",
              planKey,
              status,
              providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
              providerSubscriptionId: sub.id,
              currentPeriodEnd,
              cancelAtPeriodEnd,
            },
            update: {
              provider: "stripe",
              planKey,
              status,
              providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
              providerSubscriptionId: sub.id,
              currentPeriodEnd,
              cancelAtPeriodEnd,
            },
          });
        }
      }

      if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = (sub.metadata && (sub.metadata as any).organizationId) || null;
        const userId = (sub.metadata && (sub.metadata as any).userId) || null;
        if (typeof orgId === "string" && orgId) {
          if (event.type === "customer.subscription.deleted") {
            await prisma.subscription.upsert({
              where: { organizationId: orgId },
              create: { organizationId: orgId, provider: "stripe", planKey: "free", status: "canceled" },
              update: { planKey: "free", status: "canceled", providerSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
            });
          } else {
            await upsertFromStripeSubscription(orgId, sub);
          }
        }
        if (typeof userId === "string" && userId) {
          if (event.type === "customer.subscription.deleted") {
            await prisma.userSubscription.upsert({
              where: { userId },
              create: { userId, provider: "stripe", planKey: "free", status: "canceled" },
              update: { planKey: "free", status: "canceled", providerSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
            });
          } else {
            const priceId = sub.items.data[0]?.price?.id ?? null;
            const planKey = planKeyFromPriceId(priceId);
            const status = sub.status ?? "unknown";
            const periodEndSec = Math.max(
              0,
              ...sub.items.data
                .map((it: any) => Number(it.current_period_end) || 0)
                .filter((n: number) => Number.isFinite(n) && n > 0),
            );
            const currentPeriodEnd = periodEndSec > 0 ? new Date(periodEndSec * 1000) : null;
            const cancelAtPeriodEnd = sub.cancel_at_period_end === true;
            await prisma.userSubscription.upsert({
              where: { userId },
              create: {
                userId,
                provider: "stripe",
                planKey,
                status,
                providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
                providerSubscriptionId: sub.id,
                currentPeriodEnd,
                cancelAtPeriodEnd,
              },
              update: {
                provider: "stripe",
                planKey,
                status,
                providerCustomerId: typeof sub.customer === "string" ? sub.customer : null,
                providerSubscriptionId: sub.id,
                currentPeriodEnd,
                cancelAtPeriodEnd,
              },
            });
          }
        }
      }

      return { ok: true };
    },
  );
}
