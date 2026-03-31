import { getPrisma } from "./db.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@libsql/client";

let remotePrisma: PrismaClient | null = null;

function getRemotePrisma(): PrismaClient | null {
  if (remotePrisma) return remotePrisma;
  
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  
  if (!url || !authToken || process.env.VERCEL) return null;
  
  try {
    const client = createClient({ url, authToken });
    const adapter = new PrismaLibSql(client);
    remotePrisma = new PrismaClient({ adapter: adapter as any });
    return remotePrisma;
  } catch (e: any) {
    console.error("[Sync] Failed to initialize remote Prisma:", e.message);
    return null;
  }
}

export async function pushUserWorkToCloud(userId: string) {
  const remote = getRemotePrisma();
  const local = await getPrisma();
  if (!remote || !local) return;

  try {
    const user = await local.user.findUnique({ where: { id: userId } });
    if (user) {
      await remote.user.upsert({
        where: { id: userId },
        update: { handle: user.handle, email: user.email, displayName: user.displayName, passwordHash: user.passwordHash },
        create: { 
          id: user.id,
          handle: user.handle,
          email: user.email,
          displayName: user.displayName,
          passwordHash: user.passwordHash
        }
      });
    }

    const shares = await local.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } }
    });

    for (const share of shares) {
      await remote.graph.upsert({
        where: { id: share.graph.id },
        update: { nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode },
        create: { id: share.graph.id, nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode }
      });

      for (const node of share.graph.nodes) {
        await remote.node.upsert({
          where: { graphId_index: { graphId: share.graph.id, index: node.index } },
          update: { url: node.url, title: node.title, caption: node.caption, pauseSec: node.pauseSec },
          create: { 
            id: node.id,
            graphId: node.graphId,
            index: node.index,
            url: node.url,
            title: node.title,
            caption: node.caption,
            pauseSec: node.pauseSec
          }
        });
      }

      await remote.share.upsert({
        where: { code: share.code },
        update: { topic: share.topic, saved: share.saved },
        create: { 
          code: share.code,
          graphId: share.graphId,
          createdByUserId: share.createdByUserId,
          organizationId: share.organizationId,
          saved: share.saved,
          topic: share.topic
        }
      });
    }
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
    const remoteUser = await remote.user.findUnique({ where: { id: userId } });
    if (remoteUser) {
      await local.user.upsert({
        where: { id: userId },
        update: { handle: remoteUser.handle, email: remoteUser.email, displayName: remoteUser.displayName, passwordHash: remoteUser.passwordHash },
        create: { 
          id: remoteUser.id,
          handle: remoteUser.handle,
          email: remoteUser.email,
          displayName: remoteUser.displayName,
          passwordHash: remoteUser.passwordHash
        }
      });
    }

    const remoteShares = await remote.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } }
    });

    for (const share of remoteShares) {
      await local.graph.upsert({
        where: { id: share.graph.id },
        update: { nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode },
        create: { id: share.graph.id, nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode }
      });

      for (const node of share.graph.nodes) {
        await local.node.upsert({
          where: { graphId_index: { graphId: share.graph.id, index: node.index } },
          update: { url: node.url, title: node.title, caption: node.caption, pauseSec: node.pauseSec },
          create: { 
            id: node.id,
            graphId: node.graphId,
            index: node.index,
            url: node.url,
            title: node.title,
            caption: node.caption,
            pauseSec: node.pauseSec
          }
        });
      }

      await local.share.upsert({
        where: { code: share.code },
        update: { topic: share.topic, saved: share.saved },
        create: { 
          code: share.code,
          graphId: share.graphId,
          createdByUserId: share.createdByUserId,
          organizationId: share.organizationId,
          saved: share.saved,
          topic: share.topic
        }
      });
    }
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
      // Check if a local user already exists with this handle/email but a different ID
      const existingConflict = await local.user.findFirst({
        where: {
          OR: [
            { handle: remoteUser.handle },
            { email: remoteUser.email }
          ],
          NOT: { id: remoteUser.id }
        }
      });

      if (existingConflict) {
        console.log(`[Sync] Resolving local ID conflict for ${identifier}. Adopting remote ID ${remoteUser.id}`);
        // To resolve this cleanly, we'd ideally update all foreign keys. 
        // For now, we'll delete the partial local conflict so the remote one can be upserted.
        // (Note: In a production app, we would perform a full migration of local records).
        await local.user.delete({ where: { id: existingConflict.id } });
      }

      await local.user.upsert({
        where: { id: remoteUser.id },
        update: { 
          handle: remoteUser.handle, 
          email: remoteUser.email, 
          displayName: remoteUser.displayName, 
          passwordHash: remoteUser.passwordHash 
        },
        create: { 
          id: remoteUser.id,
          handle: remoteUser.handle,
          email: remoteUser.email,
          displayName: remoteUser.displayName,
          passwordHash: remoteUser.passwordHash
        }
      });
      console.log(`[Sync] Successfully pulled remote account for ${identifier}`);
      return true;
    }
  } catch (err: any) {
    console.warn(`[Sync] Remote user lookup failed:`, err.message);
  }
  return false;
}
