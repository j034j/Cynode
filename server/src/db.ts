import { PrismaClient } from "@prisma/client";
import * as AdapterLibSql from "@prisma/adapter-libsql";
const PrismaLibSQL: any = (AdapterLibSql as any).PrismaLibSQL || (AdapterLibSql as any).PrismaLibSql;
import path from "path";
import { fileURLToPath } from "url";
import { info, error, debug } from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let prisma: PrismaClient | null = null;
let initPromise: Promise<PrismaClient> | null = null;

function defaultLocalDatabaseUrl(): string {
  const defaultLocalPath = path.resolve(__dirname, "..", "prisma", "dev.db");
  return `file:${defaultLocalPath}`;
}

function normalizeDatabaseUrl(rawUrl?: string | null): string {
  const fallback = defaultLocalDatabaseUrl();
  const input = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : fallback;
  if (!input.startsWith("file:")) return input;

  const filePath = input.slice(5);
  if (!filePath) return fallback;
  if (path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)) return input;

  const resolved = path.resolve(__dirname, "..", filePath);
  return `file:${resolved}`;
}

export function isRemoteDatabaseUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.protocol === "libsql:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

export function isDatabasePersistenceEnabled(): boolean {
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  return Boolean(configuredDatabaseUrl || tursoUrl);
}

export function resolveDatabaseConfig() {
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || undefined;

  const normalizedDatabaseUrl = normalizeDatabaseUrl(configuredDatabaseUrl);
  const remoteUrl = tursoUrl || (isRemoteDatabaseUrl(configuredDatabaseUrl) ? configuredDatabaseUrl!.trim() : null);
  const isRemote =
    Boolean(remoteUrl) &&
    (process.env.VERCEL === "1" ||
      process.env.VERCEL === "true" ||
      Boolean(process.env.VERCEL) ||
      process.env.USE_REMOTE_DB === "true" ||
      isRemoteDatabaseUrl(configuredDatabaseUrl));

  return {
    authToken,
    isRemote,
    localUrl: normalizedDatabaseUrl,
    remoteUrl,
    runtimeUrl: isRemote ? String(remoteUrl) : normalizedDatabaseUrl,
  };
}

export async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { authToken, isRemote, localUrl, remoteUrl, runtimeUrl } = resolveDatabaseConfig();
    // Ensure Prisma sees the resolved DATABASE_URL at runtime
    try {
      process.env.DATABASE_URL = runtimeUrl;
    } catch (_) {}

    info(`[db] Mode: ${isRemote ? "Remote (Turso)" : "Local (SQLite)"}`);
    info(`[db] VERCEL_ENV: ${!!process.env.VERCEL}`);
    info(`[db] TURSO_URL_PRESENT: ${!!remoteUrl}`);

    if ((process.env.VERCEL || process.env.USE_REMOTE_DB === "true") && !isRemote) {
      error("[db] FATAL: Remote runtime detected but no remote database URL is configured.");
      throw new Error("Remote database URL is required for this deployment");
    }

    try {
      if (isRemote && remoteUrl && isRemoteDatabaseUrl(remoteUrl)) {
          info("[db] Initializing LibSql Adapter...");
        const adapter = new PrismaLibSQL({ url: remoteUrl, authToken });
        prisma = new PrismaClient({ adapter });
      } else {
        info("[db] Initializing standard SQLite...");
        if (localUrl !== runtimeUrl) {
          info(`[db] Resolved local DATABASE_URL to ${runtimeUrl}`);
        }
        prisma = new PrismaClient();
      }
      return prisma;
    } catch (err: any) {
      error("[db] CRITICAL INITIALIZATION ERROR:", err.message);
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
