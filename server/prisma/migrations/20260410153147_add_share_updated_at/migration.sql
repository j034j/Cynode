/*
  Warnings:

  - Added the required column `updatedAt` to the `Share` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Share" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "organizationId" TEXT,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "topic" TEXT,
    CONSTRAINT "Share_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Share_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Share_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Share" ("code", "createdAt", "updatedAt", "createdByUserId", "graphId", "organizationId", "saved", "topic")
SELECT "code", "createdAt", COALESCE("createdAt", CURRENT_TIMESTAMP), "createdByUserId", "graphId", "organizationId", "saved", "topic"
FROM "Share";
DROP TABLE "Share";
ALTER TABLE "new_Share" RENAME TO "Share";
CREATE INDEX "Share_graphId_idx" ON "Share"("graphId");
CREATE INDEX "Share_createdByUserId_idx" ON "Share"("createdByUserId");
CREATE INDEX "Share_organizationId_idx" ON "Share"("organizationId");
CREATE INDEX "Share_saved_idx" ON "Share"("saved");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
