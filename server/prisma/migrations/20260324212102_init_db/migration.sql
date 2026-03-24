-- AlterTable
ALTER TABLE "AnalyticsEvent" ADD COLUMN "pagePath" TEXT;
ALTER TABLE "AnalyticsEvent" ADD COLUMN "utmCampaign" TEXT;
ALTER TABLE "AnalyticsEvent" ADD COLUMN "utmContent" TEXT;
ALTER TABLE "AnalyticsEvent" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "AnalyticsEvent" ADD COLUMN "utmSource" TEXT;
ALTER TABLE "AnalyticsEvent" ADD COLUMN "utmTerm" TEXT;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN "caption" TEXT;
ALTER TABLE "Node" ADD COLUMN "pauseSec" REAL;
ALTER TABLE "Node" ADD COLUMN "title" TEXT;

-- CreateIndex
CREATE INDEX "AnalyticsEvent_utmCampaign_idx" ON "AnalyticsEvent"("utmCampaign");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_utmSource_idx" ON "AnalyticsEvent"("utmSource");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_utmMedium_idx" ON "AnalyticsEvent"("utmMedium");
