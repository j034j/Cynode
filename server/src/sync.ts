import { getPrisma } from "./db.js";
import * as AdapterLibSql from "@prisma/adapter-libsql";
const PrismaLibSQL: any = (AdapterLibSql as any).PrismaLibSQL || (AdapterLibSql as any).PrismaLibSql;
import { PrismaClient } from "@prisma/client";

let remotePrisma: PrismaClient | null = null;

function isRemoteDatabaseUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.protocol === "libsql:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function getRemotePrisma(): PrismaClient | null {
  if (remotePrisma) return remotePrisma;

  const configuredUrl = process.env.DATABASE_URL;
  const url = process.env.TURSO_DATABASE_URL || (isRemoteDatabaseUrl(configuredUrl) ? configuredUrl : undefined);
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;

  // Allow remote Prisma initialization on Vercel as long as the TURSO envs are present.
  if (!url || !authToken) return null;

  try {
    const adapter = new PrismaLibSQL({ url, authToken });
    remotePrisma = new PrismaClient({ adapter: adapter as any });
    return remotePrisma;
  } catch (e: any) {
    console.error("[Sync] Failed to initialize remote Prisma:", e.message);
    return null;
  }
}

async function syncUserRecord(
  target: PrismaClient,
  user: {
    id: string;
    handle: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    passwordHash: string | null;
  },
) {
  await target.user.upsert({
    where: { id: user.id },
    update: {
      handle: user.handle,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash,
    },
    create: {
      id: user.id,
      handle: user.handle,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash,
    },
  });
}

async function syncUserSubscription(
  target: PrismaClient,
  subscription:
    | {
        userId: string;
        provider: string;
        planKey: string;
        status: string;
        providerCustomerId: string | null;
        providerSubscriptionId: string | null;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
      }
    | null
    | undefined,
) {
  if (!subscription) return;
  await target.userSubscription.upsert({
    where: { userId: subscription.userId },
    update: {
      provider: subscription.provider,
      planKey: subscription.planKey,
      status: subscription.status,
      providerCustomerId: subscription.providerCustomerId,
      providerSubscriptionId: subscription.providerSubscriptionId,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    },
    create: {
      userId: subscription.userId,
      provider: subscription.provider,
      planKey: subscription.planKey,
      status: subscription.status,
      providerCustomerId: subscription.providerCustomerId,
      providerSubscriptionId: subscription.providerSubscriptionId,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    },
  });
}

async function syncMembershipBundles(
  target: PrismaClient,
  memberships: Array<{
    userId: string;
    organizationId: string;
    role: string;
    organization: {
      id: string;
      name: string;
      slug: string;
      customDomain: string | null;
      createdByUserId: string | null;
      subscription?: {
        organizationId: string;
        provider: string;
        planKey: string;
        status: string;
        providerCustomerId: string | null;
        providerSubscriptionId: string | null;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
      } | null;
    };
  }>,
) {
  for (const membership of memberships) {
    await target.organization.upsert({
      where: { id: membership.organization.id },
      update: {
        name: membership.organization.name,
        slug: membership.organization.slug,
        customDomain: membership.organization.customDomain,
        createdByUserId: membership.organization.createdByUserId,
      },
      create: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        customDomain: membership.organization.customDomain,
        createdByUserId: membership.organization.createdByUserId,
      },
    });

    if (membership.organization.subscription) {
      const sub = membership.organization.subscription;
      await target.subscription.upsert({
        where: { organizationId: sub.organizationId },
        update: {
          provider: sub.provider,
          planKey: sub.planKey,
          status: sub.status,
          providerCustomerId: sub.providerCustomerId,
          providerSubscriptionId: sub.providerSubscriptionId,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        },
        create: {
          organizationId: sub.organizationId,
          provider: sub.provider,
          planKey: sub.planKey,
          status: sub.status,
          providerCustomerId: sub.providerCustomerId,
          providerSubscriptionId: sub.providerSubscriptionId,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        },
      });
    }

    await target.membership.upsert({
      where: {
        userId_organizationId: {
          userId: membership.userId,
          organizationId: membership.organizationId,
        },
      },
      update: { role: membership.role },
      create: {
        userId: membership.userId,
        organizationId: membership.organizationId,
        role: membership.role,
      },
    });
  }
}

async function syncGraphWithNodes(
  target: PrismaClient,
  graph: {
    id: string;
    nodeCount: number;
    lastSelectedNode: number | null;
    updatedAt?: Date | null;
    nodes: Array<{
      id: string;
      graphId: string;
      index: number;
      url: string | null;
      title: string | null;
      caption: string | null;
      pauseSec: number | null;
      updatedAt?: Date | null;
    }>;
  },
) {
  await target.graph.upsert({
    where: { id: graph.id },
    update: {
      nodeCount: graph.nodeCount,
      lastSelectedNode: graph.lastSelectedNode,
    },
    create: {
      id: graph.id,
      nodeCount: graph.nodeCount,
      lastSelectedNode: graph.lastSelectedNode,
    },
  });

  // Simple and efficient: replace all nodes for this graph
  await target.node.deleteMany({
    where: { graphId: graph.id },
  });

  if (graph.nodes.length > 0) {
    await target.node.createMany({
      data: graph.nodes.map((node) => ({
        id: node.id,
        graphId: node.graphId,
        index: node.index,
        url: node.url,
        title: node.title,
        caption: node.caption,
        pauseSec: node.pauseSec,
      })),
    });
  }
}

async function syncShares(
  target: PrismaClient,
  shares: Array<{
    code: string;
    graphId: string;
    createdByUserId: string | null;
    organizationId: string | null;
    saved: boolean;
    topic: string | null;
    graph: {
      id: string;
      nodeCount: number;
      lastSelectedNode: number | null;
      updatedAt?: Date | null;
      nodes: Array<{
        id: string;
        graphId: string;
        index: number;
        url: string | null;
        title: string | null;
        caption: string | null;
        pauseSec: number | null;
        updatedAt?: Date | null;
      }>;
    };
  }>,
) {
  for (const share of shares) {
    await syncGraphWithNodes(target, share.graph);
    await target.share.upsert({
      where: { code: share.code },
      update: {
        graphId: share.graphId,
        createdByUserId: share.createdByUserId,
        organizationId: share.organizationId,
        saved: share.saved,
        topic: share.topic,
      },
      create: {
        code: share.code,
        graphId: share.graphId,
        createdByUserId: share.createdByUserId,
        organizationId: share.organizationId,
        saved: share.saved,
        topic: share.topic,
      },
    });
  }
}

// Sync shares with conflict resolution: only update if incoming data is fresher (has newer updatedAt)
async function syncSharesWithConflictResolution(
  target: PrismaClient,
  shares: Array<{
    code: string;
    graphId: string;
    createdByUserId: string | null;
    organizationId: string | null;
    saved: boolean;
    topic: string | null;
    updatedAt?: Date;
    graph: {
      id: string;
      nodeCount: number;
      lastSelectedNode: number | null;
      updatedAt?: Date | null;
      nodes: Array<{
        id: string;
        graphId: string;
        index: number;
        url: string | null;
        title: string | null;
        caption: string | null;
        pauseSec: number | null;
        updatedAt?: Date | null;
      }>;
    };
  }>,
) {
  for (const share of shares) {
    // Sync graph first
    await syncGraphWithNodes(target, share.graph);

    // Check conflict: if target already has this share and target's version is fresher, skip
    const existing = await target.share.findUnique({ where: { code: share.code } });
    if (existing && existing.updatedAt && share.updatedAt && existing.updatedAt > share.updatedAt) {
      console.log(`[Sync] Skipping share ${share.code}: target version is fresher`);
      continue;
    }

    await target.share.upsert({
      where: { code: share.code },
      update: {
        graphId: share.graphId,
        createdByUserId: share.createdByUserId,
        organizationId: share.organizationId,
        saved: share.saved,
        topic: share.topic,
      },
      create: {
        code: share.code,
        graphId: share.graphId,
        createdByUserId: share.createdByUserId,
        organizationId: share.organizationId,
        saved: share.saved,
        topic: share.topic,
      },
    });
  }
}

export async function pushUserWorkToCloud(userId: string) {
  const remote = getRemotePrisma();
  const local = await getPrisma();
  if (!remote || !local) return;

  try {
    const user = await local.user.findUnique({
      where: { id: userId },
      include: {
        subscription: true,
        memberships: {
          include: { organization: { include: { subscription: true } } },
        },
      },
    });
    if (user) {
      const remoteUser = await remote.user.findUnique({ where: { id: userId } });
      if (remoteUser && remoteUser.updatedAt && user.updatedAt && remoteUser.updatedAt > user.updatedAt) {
        console.log(`[Sync] Skipping user upsert for ${userId}: remote is fresher`);
      } else {
        await syncUserRecord(remote, user);
      }
      await syncUserSubscription(remote, user.subscription);
      await syncMembershipBundles(remote, user.memberships);
    }

    const shares = await local.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } },
    });

    // Sync shares with conflict resolution based on updatedAt timestamp
    await syncSharesWithConflictResolution(remote, shares);
    console.log(`[Sync] Background push successful for user ${userId}`);
  } catch (err: any) {
    console.warn(`[Sync] Background push failed:`, err.message);
  }
}

export async function pullUserWorkFromCloud(userId: string) {
  const remote = getRemotePrisma();
  const local = await getPrisma();
  if (!remote || !local) return;

  try {
    const remoteUser = await remote.user.findUnique({
      where: { id: userId },
      include: {
        subscription: true,
        memberships: {
          include: { organization: { include: { subscription: true } } },
        },
      },
    });
    if (remoteUser) {
      const localUser = await local.user.findUnique({ where: { id: userId } });
      if (localUser && localUser.updatedAt && remoteUser.updatedAt && localUser.updatedAt > remoteUser.updatedAt) {
        console.log(`[Sync] Skipping local user upsert for ${userId}: local is fresher`);
      } else {
        await syncUserRecord(local, remoteUser);
      }
      await syncUserSubscription(local, remoteUser.subscription);
      await syncMembershipBundles(local, remoteUser.memberships);
    }

    const remoteShares = await remote.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } },
    });

    // Sync shares with conflict resolution based on updatedAt timestamp
    await syncSharesWithConflictResolution(local, remoteShares);
    console.log(`[Sync] Background pull successful for user ${userId}`);
  } catch (err: any) {
    console.warn(`[Sync] Background pull failed:`, err.message);
  }
}

export async function findAndPullRemoteUser(identifier: string): Promise<boolean> {
  const remote = getRemotePrisma();
  const local = await getPrisma();
  if (!remote || !local) return false;

  try {
    const ident = identifier.trim().toLowerCase();
    const remoteUser = ident.includes("@")
      ? await remote.user.findUnique({ where: { email: ident } })
      : await remote.user.findUnique({ where: { handle: ident } });

    if (remoteUser) {
      const existingConflict = await local.user.findFirst({
        where: {
          OR: [
            { handle: remoteUser.handle },
            { email: remoteUser.email },
          ],
          NOT: { id: remoteUser.id },
        },
      });

      if (existingConflict) {
        const [shareCount, membershipCount, sessionCount] = await Promise.all([
          local.share.count({ where: { createdByUserId: existingConflict.id } }),
          local.membership.count({ where: { userId: existingConflict.id } }),
          local.session.count({ where: { userId: existingConflict.id } }),
        ]);

        if (shareCount > 0 || membershipCount > 0 || sessionCount > 0) {
          console.warn(
            `[Sync] Refusing to delete conflicting local user ${existingConflict.id}; local account already has persisted data.`,
          );
          return false;
        }

        console.log(`[Sync] Resolving local ID conflict for ${identifier}. Adopting remote ID ${remoteUser.id}`);
        await local.user.delete({ where: { id: existingConflict.id } });
      }

      await pullUserWorkFromCloud(remoteUser.id);
      console.log(`[Sync] Successfully pulled remote account for ${identifier}`);
      return true;
    }
  } catch (err: any) {
    console.warn(`[Sync] Remote user lookup failed:`, err.message);
  }
  return false;
}
