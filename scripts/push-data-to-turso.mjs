import 'dotenv/config';
import { createClient } from '@libsql/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

if (!tursoUrl || !tursoToken) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env');
  process.exit(1);
}

// 1. Initialize Local Prisma (Default SQLite)
const localPrisma = new PrismaClient();

// 2. Initialize Remote Prisma (Turso)
const adapter = new PrismaLibSql({
  url: tursoUrl,
  authToken: tursoToken,
});
const remotePrisma = new PrismaClient({ adapter });

async function sync() {
  console.log('Starting data sync: Local -> Turso');

  try {
    // Sync Users
    const users = await localPrisma.user.findMany();
    console.log(`Syncing ${users.length} users...`);
    for (const user of users) {
      await remotePrisma.user.upsert({
        where: { id: user.id },
        update: { ...user },
        create: { ...user },
      });
    }

    // Sync Organizations
    const orgs = await localPrisma.organization.findMany();
    console.log(`Syncing ${orgs.length} organizations...`);
    for (const org of orgs) {
      await remotePrisma.organization.upsert({
        where: { id: org.id },
        update: { ...org },
        create: { ...org },
      });
    }

    // Sync Memberships
    const memberships = await localPrisma.membership.findMany();
    console.log(`Syncing ${memberships.length} memberships...`);
    for (const m of memberships) {
      await remotePrisma.membership.upsert({
        where: { id: m.id },
        update: { ...m },
        create: { ...m },
      });
    }

    // Sync Graphs
    const graphs = await localPrisma.graph.findMany();
    console.log(`Syncing ${graphs.length} graphs...`);
    for (const graph of graphs) {
      await remotePrisma.graph.upsert({
        where: { id: graph.id },
        update: { ...graph },
        create: { ...graph },
      });
    }

    // Sync Nodes
    const nodes = await localPrisma.node.findMany();
    console.log(`Syncing ${nodes.length} nodes...`);
    for (const node of nodes) {
      await remotePrisma.node.upsert({
        where: { id: node.id },
        update: { ...node },
        create: { ...node },
      });
    }

    // Sync Shares
    const shares = await localPrisma.share.findMany();
    console.log(`Syncing ${shares.length} shares...`);
    for (const share of shares) {
      await remotePrisma.share.upsert({
        where: { code: share.code },
        update: { ...share },
        create: { ...share },
      });
    }

    console.log('\nData sync complete!');
  } catch (err) {
    console.error('Sync failed:', err.message);
  } finally {
    await localPrisma.$disconnect();
    await remotePrisma.$disconnect();
  }
}

sync();
