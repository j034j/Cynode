import { getPrisma } from "./db.js";

export type PlanKey = "free" | "pro" | "ultra";

export type Plan = {
  key: PlanKey;
  name: string;
  monthlyCredits: number | null; // null = unlimited
  maxSavedLinksPerMonth: number | null;
  maxMediaMBPerMonth: number | null;
  analyticsRetentionDays: number | null;
};

export function getPlans(): Plan[] {
  return [
    {
      key: "free",
      name: "Free",
      monthlyCredits: 150,
      maxSavedLinksPerMonth: 25,
      maxMediaMBPerMonth: 75,
      analyticsRetentionDays: 14,
    },
    {
      key: "pro",
      name: "Pro",
      monthlyCredits: 5000,
      maxSavedLinksPerMonth: 1500,
      maxMediaMBPerMonth: 2000,
      analyticsRetentionDays: 180,
    },
    {
      key: "ultra",
      name: "Ultra",
      monthlyCredits: null,
      maxSavedLinksPerMonth: null,
      maxMediaMBPerMonth: null,
      analyticsRetentionDays: 365,
    },
  ];
}

export function planByKey(key: string | null | undefined): Plan {
  const k = (key || "free").toLowerCase() as PlanKey;
  return getPlans().find((p) => p.key === k) ?? getPlans()[0];
}

export function isUnlimitedUser(user: { handle: string } | null | undefined): boolean {
  const unlimitedHandle = (process.env.UNLIMITED_HANDLE || "cyn").toLowerCase();
  return !!user && String(user.handle || "").toLowerCase() === unlimitedHandle;
}

export function monthPeriodStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function nextMonthPeriodStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export async function getOrCreateUsageCounter(subjectType: "user" | "org", subjectId: string, now = new Date()) {
  const prisma = getPrisma();
  const periodStart = monthPeriodStart(now);
  return await prisma.usageCounter.upsert({
    where: { subjectType_subjectId_periodStart: { subjectType, subjectId, periodStart } },
    create: { subjectType, subjectId, periodStart },
    update: {},
  });
}

export async function addUsage(subjectType: "user" | "org", subjectId: string, delta: Partial<{
  creditsUsed: number;
  savedLinksCreated: number;
  mediaBytesUploaded: number;
  analyticsEvents: number;
}>) {
  const prisma = getPrisma();
  const periodStart = monthPeriodStart(new Date());
  await prisma.usageCounter.upsert({
    where: { subjectType_subjectId_periodStart: { subjectType, subjectId, periodStart } },
    create: {
      subjectType,
      subjectId,
      periodStart,
      creditsUsed: delta.creditsUsed ?? 0,
      savedLinksCreated: delta.savedLinksCreated ?? 0,
      mediaBytesUploaded: delta.mediaBytesUploaded ?? 0,
      analyticsEvents: delta.analyticsEvents ?? 0,
    },
    update: {
      creditsUsed: { increment: delta.creditsUsed ?? 0 },
      savedLinksCreated: { increment: delta.savedLinksCreated ?? 0 },
      mediaBytesUploaded: { increment: delta.mediaBytesUploaded ?? 0 },
      analyticsEvents: { increment: delta.analyticsEvents ?? 0 },
    },
  });
}

export function creditsForSavedLink(): number {
  return 5;
}

export function creditsForMediaBytes(bytes: number): number {
  // 1 credit per MB (rounded up).
  const mb = Math.ceil(Math.max(0, bytes) / (1024 * 1024));
  return Math.max(1, mb);
}

