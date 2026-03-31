import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const localUrl = process.env.DATABASE_URL;
    
    // Determine if we should use the remote database (Turso)
    // We use remote if:
    // 1. We are running on Vercel (production) AND Turso URL is provided.
    // 2. OR USE_REMOTE_DB=true is explicitly set.
    const useRemote = (process.env.VERCEL && tursoUrl) || process.env.USE_REMOTE_DB === "true";
    
    const url = useRemote ? (tursoUrl || localUrl || "") : (localUrl || tursoUrl || "");
    
    if (url.startsWith("libsql://") || url.startsWith("https://")) {
      console.log("[db] Initializing Prisma with LibSql adapter (Remote)");
      const adapter = new PrismaLibSql({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
      prisma = new PrismaClient({ adapter });
    } else {
      console.log("[db] Initializing Prisma with default SQLite (Local)");
      prisma = new PrismaClient();
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
