-- CreateTable
CREATE TABLE "Graph" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeCount" INTEGER NOT NULL,
    "lastSelectedNode" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "url" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Node_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Node_graphId_idx" ON "Node"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "Node_graphId_index_key" ON "Node"("graphId", "index");
