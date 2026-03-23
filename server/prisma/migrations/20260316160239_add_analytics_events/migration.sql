-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareCode" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nodeIndex" INTEGER,
    "url" TEXT,
    "viewerHash" TEXT,
    "referrer" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalyticsEvent_shareCode_fkey" FOREIGN KEY ("shareCode") REFERENCES "Share" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shareCode_idx" ON "AnalyticsEvent"("shareCode");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_type_idx" ON "AnalyticsEvent"("type");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_createdAt_idx" ON "AnalyticsEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shareCode_type_createdAt_idx" ON "AnalyticsEvent"("shareCode", "type", "createdAt");
