import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;
    const localUrl = process.env.DATABASE_URL || "file:./dev.db";
    
    // Remote connection check
    const isRemote = (process.env.VERCEL && tursoUrl) || process.env.USE_REMOTE_DB === "true";
    const url = isRemote ? (tursoUrl || localUrl) : localUrl;
    
    if (url.startsWith("libsql://") || url.startsWith("https://")) {
      console.log("[db] Initializing Prisma with LibSql Factory (Remote)");
      const factory = new PrismaLibSql({ url, authToken: tursoToken });
      
      // Note: In Prisma 7, we must pass the factory or use it to connect. 
      // Based on types, it implements SqlDriverAdapterFactory.
      // We pass the factory directly to PrismaClient (it will handle connecting inside).
      prisma = new PrismaClient({ adapter: factory as any });
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
