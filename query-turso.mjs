import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || "";
const authToken = process.env.TURSO_AUTH_TOKEN || "";

const adapter = new PrismaLibSql({ url, authToken });
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    // Query for all tables 
    const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
    console.log("=== TURSO Database Tables ===");
    for (const t of tables) {
      console.log(t.name);
    }

    // Count rows
    const userCount = await prisma.user.count();
    console.log(`\nUsers: ${userCount}`);

    const graphCount = await prisma.graph.count();
    console.log(`Graphs: ${graphCount}`);

    const shareCount = await prisma.share.count();
    console.log(`Shares: ${shareCount}`);
  } catch (e) {
    console.error("Error connecting to Turso:", e.message);
  }
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