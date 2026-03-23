import { PrismaClient } from "../generated/prisma-client/index.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "";
    
    // In Vercel serverless environment, if we are NOT using Turso/Remote DB, 
    // we need to be careful with SQLite. However, since the user is using Turso 
    // for deployment, we should ensure the adapter is always used when a remote URL is present.
    if (url.startsWith("libsql://") || url.startsWith("https://")) {
      const adapter = new PrismaLibSql({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
      prisma = new PrismaClient({ adapter });
    } else {
      // Local SQLite
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
