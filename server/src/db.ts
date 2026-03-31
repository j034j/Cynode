import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

let prisma: PrismaClient | null = null;
let initPromise: Promise<PrismaClient> | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;
    const localUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
    
    // Remote connection check
    const isRemote = (process.env.VERCEL && tursoUrl) || process.env.USE_REMOTE_DB === "true";
    const url = isRemote ? (tursoUrl || localUrl) : localUrl;
    
    console.log(`[db] Mode: ${isRemote ? "Remote (Turso)" : "Local (SQLite)"}`);
    console.log(`[db] VERCEL_ENV: ${!!process.env.VERCEL}`);
    console.log(`[db] TURSO_URL_PRESENT: ${!!tursoUrl}`);

    if (process.env.VERCEL && !tursoUrl) {
      console.error("[db] FATAL: Running on Vercel but TURSO_DATABASE_URL is missing. Refusing to initialize remote DB.");
      // Fail fast to avoid running with an unsupported local SQLite DB in serverless environment
      throw new Error("TURSO_DATABASE_URL is required on Vercel deployments");
    }
    
    try {
      if (isRemote && url && (url.startsWith("libsql://") || url.startsWith("https://"))) {
        console.log("[db] Initializing LibSql Adapter...");
        // Use adapter config directly to satisfy type expectations in TS build
        const adapter = new PrismaLibSql({ url, authToken: tursoToken });
        prisma = new PrismaClient({ adapter });
      } else {
        console.log("[db] Initializing standard SQLite...");
        prisma = new PrismaClient();
      }
      return prisma;
    } catch (err: any) {
      console.error("[db] CRITICAL INITIALIZATION ERROR:", err.message);
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

export async function closePrisma(): Promise<void> {
  if (prisma) {
    const p = prisma;
    prisma = null;
    initPromise = null;
    await p.$disconnect();
  }
}
