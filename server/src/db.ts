import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let prisma: PrismaClient | null = null;
let initPromise: Promise<PrismaClient> | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  if (initPromise) return initPromise;

  initPromise = (async () => {
      const tursoUrl = process.env.TURSO_DATABASE_URL;
      const tursoToken = process.env.TURSO_AUTH_TOKEN;
      // Resolve default local SQLite DB relative to the built server directory so runtime
      // paths work regardless of current working directory.
      const defaultLocalPath = path.resolve(__dirname, "..", "prisma", "dev.db");
      const localUrl = process.env.DATABASE_URL || `file:${defaultLocalPath}`;
    
    // Remote connection check
    const isRemote = (process.env.VERCEL && tursoUrl) || process.env.USE_REMOTE_DB === "true";
    // If DATABASE_URL is provided in env, prefer that. If it's a relative file: URL, resolve it
    // relative to the built server directory so runtime paths work regardless of CWD.
    let url = isRemote ? (tursoUrl || localUrl) : localUrl;
    if (process.env.DATABASE_URL) {
      url = process.env.DATABASE_URL;
      if (url.startsWith("file:")) {
        const filePath = url.slice(5);
        if (!path.isAbsolute(filePath) && !/^[A-Za-z]:[\\/]/.test(filePath)) {
          const resolved = path.resolve(__dirname, "..", filePath);
          url = `file:${resolved}`;
          console.log(`[db] Resolved relative DATABASE_URL to ${url}`);
        }
      }
    }
    // Ensure Prisma sees the resolved DATABASE_URL at runtime
    try {
      process.env.DATABASE_URL = url;
    } catch (_) {}
    
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
