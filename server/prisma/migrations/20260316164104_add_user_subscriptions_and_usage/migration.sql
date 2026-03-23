-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "currentPeriodEnd" DATETIME,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "creditsUsed" INTEGER NOT NULL DEFAULT 0,
    "savedLinksCreated" INTEGER NOT NULL DEFAULT 0,
    "mediaBytesUploaded" INTEGER NOT NULL DEFAULT 0,
    "analyticsEvents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_userId_key" ON "UserSubscription"("userId");

-- CreateIndex
CREATE INDEX "UserSubscription_provider_idx" ON "UserSubscription"("provider");

-- CreateIndex
CREATE INDEX "UserSubscription_planKey_idx" ON "UserSubscription"("planKey");

-- CreateIndex
CREATE INDEX "UserSubscription_status_idx" ON "UserSubscription"("status");

-- CreateIndex
CREATE INDEX "UsageCounter_subjectType_subjectId_idx" ON "UsageCounter"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "UsageCounter_periodStart_idx" ON "UsageCounter"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_subjectType_subjectId_periodStart_key" ON "UsageCounter"("subjectType", "subjectId", "periodStart");
