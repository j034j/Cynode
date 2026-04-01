import { getPrisma } from "./db.js";
import * as AdapterLibSql from "@prisma/adapter-libsql";
const PrismaLibSQL: any = (AdapterLibSql as any).PrismaLibSQL || (AdapterLibSql as any).PrismaLibSql;
import { PrismaClient } from "@prisma/client";
import { createClient } from "@libsql/client";

let remotePrisma: PrismaClient | null = null;

function getRemotePrisma(): PrismaClient | null {
  if (remotePrisma) return remotePrisma;
  
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

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

export async function pushUserWorkToCloud(userId: string) {
  const remote = getRemotePrisma();
  const local = await getPrisma();
  if (!remote || !local) return;

  try {
    const user = await local.user.findUnique({ where: { id: userId } });
    if (user) {
      // Check remote freshness: if remote has a newer updatedAt, skip overwriting.
      const remoteUser = await remote.user.findUnique({ where: { id: userId } });
      if (remoteUser && remoteUser.updatedAt && user.updatedAt && remoteUser.updatedAt > user.updatedAt) {
        console.log(`[Sync] Skipping user upsert for ${userId}: remote is fresher`);
      } else {
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
    }

    const shares = await local.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } }
    });

    for (const share of shares) {
      // Graph: only upsert if local is newer than remote (if remote exists)
      const remoteGraph = await remote.graph.findUnique({ where: { id: share.graph.id } });
      if (remoteGraph && remoteGraph.updatedAt && share.graph.updatedAt && remoteGraph.updatedAt > share.graph.updatedAt) {
        console.log(`[Sync] Skipping graph upsert for ${share.graph.id}: remote is fresher`);
      } else {
        await remote.graph.upsert({
          where: { id: share.graph.id },
          update: { nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode },
          create: { id: share.graph.id, nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode }
        });

        for (const node of share.graph.nodes) {
          const remoteNode = await remote.node.findUnique({ where: { graphId_index: { graphId: share.graph.id, index: node.index } } });
          if (remoteNode && remoteNode.updatedAt && node.updatedAt && remoteNode.updatedAt > node.updatedAt) {
            console.log(`[Sync] Skipping node upsert for graph ${share.graph.id} index ${node.index}: remote is fresher`);
            continue;
          }
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
      const localUser = await local.user.findUnique({ where: { id: userId } });
      if (localUser && localUser.updatedAt && remoteUser.updatedAt && localUser.updatedAt > remoteUser.updatedAt) {
        console.log(`[Sync] Skipping local user upsert for ${userId}: local is fresher`);
      } else {
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
    }

    const remoteShares = await remote.share.findMany({
      where: { createdByUserId: userId },
      include: { graph: { include: { nodes: true } } }
    });

    for (const share of remoteShares) {
      const localGraph = await local.graph.findUnique({ where: { id: share.graph.id } });
      if (localGraph && localGraph.updatedAt && share.graph.updatedAt && localGraph.updatedAt > share.graph.updatedAt) {
        console.log(`[Sync] Skipping local graph upsert for ${share.graph.id}: local is fresher`);
      } else {
        await local.graph.upsert({
          where: { id: share.graph.id },
          update: { nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode },
          create: { id: share.graph.id, nodeCount: share.graph.nodeCount, lastSelectedNode: share.graph.lastSelectedNode }
        });

        for (const node of share.graph.nodes) {
          const localNode = await local.node.findUnique({ where: { graphId_index: { graphId: share.graph.id, index: node.index } } });
          if (localNode && localNode.updatedAt && node.updatedAt && localNode.updatedAt > node.updatedAt) {
            console.log(`[Sync] Skipping local node upsert for graph ${share.graph.id} index ${node.index}: local is fresher`);
            continue;
          }
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
