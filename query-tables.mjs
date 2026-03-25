import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Query for all tables in SQLite
  const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
  console.log("=== LOCAL SQLite Tables ===");
  for (const t of tables) {
    console.log(t.name);
  }

  // Count rows in User table
  const userCount = await prisma.user.count();
  console.log(`\nUsers: ${userCount}`);

  const graphCount = await prisma.graph.count();
  console.log(`Graphs: ${graphCount}`);

  const shareCount = await prisma.share.count();
  console.log(`Shares: ${shareCount}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });