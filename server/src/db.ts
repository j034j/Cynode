import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;
    const localUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
    
    // Remote connection check
    const isRemote = (process.env.VERCEL && tursoUrl) || process.env.USE_REMOTE_DB === "true";
    const url = isRemote ? (tursoUrl || localUrl) : localUrl;
    
    console.log(`[db] Mode: ${isRemote ? "Remote (Turso)" : "Local (SQLite)"}`);
    console.log(`[db] URL Present: ${!!url}`);
    console.log(`[db] Token Present: ${!!tursoToken}`);

    try {
      if (isRemote && url && (url.startsWith("libsql://") || url.startsWith("https://"))) {
        console.log("[db] Initializing with LibSql Factory...");
        const factory = new PrismaLibSql({ url, authToken: tursoToken });
        prisma = new PrismaClient({ adapter: factory as any });
      } else {
        console.log("[db] Initializing with standard SQLite...");
        prisma = new PrismaClient();
      }
    } catch (err: any) {
      console.error("[db] CRITICAL INITIALIZATION ERROR:", err.message);
      throw err; // Re-throw to show in Vercel logs
    }
  }
  return prisma;
}

export async function closePrisma(): Promise<void> {
  if (!prisma) return;
  const p = prisma;
  prisma = null;
  await p.$disconnect();
}
