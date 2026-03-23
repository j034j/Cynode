-- CreateTable
CREATE TABLE "Share" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Share_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Share_graphId_idx" ON "Share"("graphId");
