import 'dotenv/config';
import { createClient } from '@libsql/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'url';
import { info, error } from './logger.mjs';

// 1. Initialize Local Prisma (Default SQLite)
const localPrisma = new PrismaClient();

async function _sync(tursoUrl, tursoToken) {
  info('Starting data sync: Local -> Turso');

  if (!tursoUrl || !tursoToken) {
    throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables');
  }

  const adapter = new PrismaLibSQL({
    url: tursoUrl,
    authToken: tursoToken,
  });
  const remotePrisma = new PrismaClient({ adapter });

  try {
    // Sync Users
    const users = await localPrisma.user.findMany();
    info(`Syncing ${users.length} users...`);
    for (const user of users) {
      await remotePrisma.user.upsert({
        where: { id: user.id },
        update: { ...user },
        create: { ...user },
      });
    }

    // Sync Organizations
    const orgs = await localPrisma.organization.findMany();
    info(`Syncing ${orgs.length} organizations...`);
    for (const org of orgs) {
      await remotePrisma.organization.upsert({
        where: { id: org.id },
        update: { ...org },
        create: { ...org },
      });
    }

    // Sync Memberships
    const memberships = await localPrisma.membership.findMany();
    info(`Syncing ${memberships.length} memberships...`);
    for (const m of memberships) {
      await remotePrisma.membership.upsert({
        where: { id: m.id },
        update: { ...m },
        create: { ...m },
      });
    }

    // Sync Graphs
    const graphs = await localPrisma.graph.findMany();
    info(`Syncing ${graphs.length} graphs...`);
    for (const graph of graphs) {
      await remotePrisma.graph.upsert({
        where: { id: graph.id },
        update: { ...graph },
        create: { ...graph },
      });
    }

    // Sync Nodes
    const nodes = await localPrisma.node.findMany();
    info(`Syncing ${nodes.length} nodes...`);
    for (const node of nodes) {
      await remotePrisma.node.upsert({
        where: { id: node.id },
        update: { ...node },
        create: { ...node },
      });
    }

    // Sync Shares
    const shares = await localPrisma.share.findMany();
    info(`Syncing ${shares.length} shares...`);
    for (const share of shares) {
      await remotePrisma.share.upsert({
        where: { code: share.code },
        update: { ...share },
        create: { ...share },
      });
    }

    info('\nData sync complete!');
  } catch (err) {
    error('Sync failed:', err?.message ?? err);
    throw err;
  } finally {
    await localPrisma.$disconnect();
    await remotePrisma.$disconnect();
  }
}

// adapter entry: call internal _sync with resolved env values
export async function sync(options = {}) {
  const tursoUrl = options.tursoUrl ?? process.env.TURSO_DATABASE_URL;
  const tursoToken = options.tursoToken ?? process.env.TURSO_AUTH_TOKEN;
  return _sync(tursoUrl, tursoToken);
}

// Run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch((err) => {
    console.error('Sync failed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
