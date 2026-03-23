import crypto from "node:crypto";
import type { Prisma } from "../generated/prisma-client/index.js";
import { getPrisma } from "./db.js";

export type GraphState = {
  id: string;
  nodeCount: number;
  lastSelectedNode: number | null;
  nodeUrls: Record<string, string>;
  nodeCaptions?: Record<string, { title: string; caption: string }>;
  nodePauseSecByNode?: Record<string, number>;
  updatedAt: string; // ISO
};

const graphs = new Map<string, GraphState>();
const shares = new Map<string, { graphId: string; createdAt: string; topic: string | null }>();

const SHARE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function randomShareCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const b of bytes) out += SHARE_ALPHABET[b % SHARE_ALPHABET.length];
  return out;
}

function isDbEnabled(): boolean {
  // Read at call-time so `.env` loading order can't accidentally disable DB usage.
  return Boolean(process.env.DATABASE_URL);
}

export async function createGraph(
  input?: Partial<Omit<GraphState, "id" | "updatedAt">>,
): Promise<GraphState> {
  const now = new Date().toISOString();
  const nodeCount = clampInt(input?.nodeCount ?? 8, 1, 20);
  const nodeUrls = normalizeNodeUrls(input?.nodeUrls ?? {}, nodeCount);
  const lastSelectedNode =
    typeof input?.lastSelectedNode === "number" && Number.isFinite(input.lastSelectedNode)
      ? clampInt(input.lastSelectedNode, 1, nodeCount)
      : null;
  const nodeCaptions = input?.nodeCaptions ?? {};
  const nodePauseSecByNode = input?.nodePauseSecByNode ?? {};

  if (isDbEnabled()) {
    const prisma = getPrisma();
    const created = await prisma.graph.create({
      data: {
        nodeCount,
        lastSelectedNode,
      },
    });

    // Persist URLs and Captions
    const indices = new Set([
      ...Object.keys(nodeUrls),
      ...Object.keys(nodeCaptions),
      ...Object.keys(nodePauseSecByNode),
    ].map(Number).filter((x) => Number.isFinite(x) && x >= 1 && x <= nodeCount));

    const nodeEntries = Array.from(indices).map((idx) => {
      const url = nodeUrls[String(idx)] ?? null;
      const title = nodeCaptions[String(idx)]?.title ?? null;
      const caption = nodeCaptions[String(idx)]?.caption ?? null;
      const pauseSec = Number(nodePauseSecByNode[String(idx)]);
      return { index: idx, url, title, caption, pauseSec: Number.isFinite(pauseSec) ? pauseSec : null };
    });

    if (nodeEntries.length > 0) {
      await prisma.node.createMany({
        data: nodeEntries.map((x) => ({ graphId: created.id, index: x.index, url: x.url, title: x.title, caption: x.caption, pauseSec: x.pauseSec })),
      });
    }

    return {
      id: created.id,
      nodeCount: created.nodeCount,
      lastSelectedNode: created.lastSelectedNode ?? null,
      nodeUrls,
      nodeCaptions,
      nodePauseSecByNode,
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  const id = crypto.randomUUID();
  const graph: GraphState = { id, nodeCount, lastSelectedNode, nodeUrls, nodeCaptions, updatedAt: now };
  graphs.set(id, graph);
  return graph;
}

export async function getGraph(id: string): Promise<GraphState | null> {
  if (isDbEnabled()) {
    const prisma = getPrisma();
    const graph = await prisma.graph.findUnique({
      where: { id },
      include: { nodes: true },
    });
    if (!graph) return null;

    const nodeUrls: Record<string, string> = {};
    const nodeCaptions: Record<string, { title: string; caption: string }> = {};
    const nodePauseSecByNode: Record<string, number> = {};
    for (const node of graph.nodes) {
      if (node.url && node.url.trim()) nodeUrls[String(node.index)] = node.url.trim();
      if ((node.title && node.title.trim()) || (node.caption && node.caption.trim())) {
        nodeCaptions[String(node.index)] = {
          title: node.title ?? "",
          caption: node.caption ?? "",
        };
      }
      const pauseSec = Number((node as any).pauseSec);
      if (Number.isFinite(pauseSec)) {
        nodePauseSecByNode[String(node.index)] = pauseSec;
      }
    }

    return {
      id: graph.id,
      nodeCount: graph.nodeCount,
      lastSelectedNode: graph.lastSelectedNode ?? null,
      nodeUrls,
      nodeCaptions,
      nodePauseSecByNode,
      updatedAt: graph.updatedAt.toISOString(),
    };
  }

  return graphs.get(id) ?? null;
}

export async function putGraph(
  id: string,
  input: Pick<GraphState, "nodeCount" | "lastSelectedNode" | "nodeUrls"> & Partial<Pick<GraphState, "nodeCaptions" | "nodePauseSecByNode">>,
): Promise<GraphState | null> {
  if (isDbEnabled()) {
    const prisma = getPrisma();
    const nodeCount = clampInt(input.nodeCount, 1, 20);
    const nodeUrls = normalizeNodeUrls(input.nodeUrls, nodeCount);
    const lastSelectedNode =
      typeof input.lastSelectedNode === "number" && Number.isFinite(input.lastSelectedNode)
        ? clampInt(input.lastSelectedNode, 1, nodeCount)
        : null;
    const nodeCaptions = input.nodeCaptions ?? {};
    const nodePauseSecByNode = input.nodePauseSecByNode ?? {};

    const existing = await prisma.graph.findUnique({ where: { id } });
    if (!existing) return null;

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const g = await tx.graph.update({
        where: { id },
        data: { nodeCount, lastSelectedNode },
      });

      await tx.node.deleteMany({
        where: { graphId: id, index: { gt: nodeCount } },
      });

      for (let i = 1; i <= nodeCount; i++) {
        const url = nodeUrls[String(i)] ?? null;
        const title = nodeCaptions[String(i)]?.title ?? null;
        const caption = nodeCaptions[String(i)]?.caption ?? null;
        const pauseSec = Number(nodePauseSecByNode[String(i)]);
        const normalizedPauseSec = Number.isFinite(pauseSec) ? pauseSec : null;
        if (url || title || caption || normalizedPauseSec !== null) {
          await tx.node.upsert({
            where: { graphId_index: { graphId: id, index: i } },
            create: { graphId: id, index: i, url, title, caption, pauseSec: normalizedPauseSec } as any,
            update: { url, title, caption, pauseSec: normalizedPauseSec } as any,
          });
        }
      }

      return g;
    });

    return {
      id,
      nodeCount,
      lastSelectedNode,
      nodeUrls,
      nodeCaptions,
      nodePauseSecByNode,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  const existing = graphs.get(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nodeCount = clampInt(input.nodeCount, 1, 20);
  const nodeUrls = normalizeNodeUrls(input.nodeUrls, nodeCount);
  const lastSelectedNode =
    typeof input.lastSelectedNode === "number" && Number.isFinite(input.lastSelectedNode)
      ? clampInt(input.lastSelectedNode, 1, nodeCount)
      : null;
  const nodeCaptions = input.nodeCaptions ?? {};
  const nodePauseSecByNode = input.nodePauseSecByNode ?? {};

  const updated: GraphState = { id, nodeCount, lastSelectedNode, nodeUrls, nodeCaptions, nodePauseSecByNode, updatedAt: now };
  graphs.set(id, updated);
  return updated;
}

export type ShareState = {
  code: string;
  graphId: string;
  createdByUserId: string | null;
  organizationId: string | null;
  topic: string | null;
  saved: boolean;
  createdAt: string; // ISO
};

export function compactGraphStateForPersistence(
  input: Pick<GraphState, "nodeCount" | "lastSelectedNode" | "nodeUrls"> & Partial<Pick<GraphState, "nodeCaptions" | "nodePauseSecByNode">>,
): (Pick<GraphState, "nodeCount" | "lastSelectedNode" | "nodeUrls"> & Partial<Pick<GraphState, "nodeCaptions" | "nodePauseSecByNode">>) | null {
  const requestedNodeCount = clampInt(input.nodeCount, 1, 20);
  const rawUrls = normalizeNodeUrls(input.nodeUrls ?? {}, requestedNodeCount);
  const rawCaptions = input.nodeCaptions ?? {};
  const rawPauseSecByNode = input.nodePauseSecByNode ?? {};

  const populatedNodeIds = Object.keys(rawUrls)
    .map(Number)
    .filter((idx) => Number.isFinite(idx) && idx >= 1 && idx <= requestedNodeCount)
    .sort((a, b) => a - b);

  if (populatedNodeIds.length < 1) return null;

  const nodeUrls: Record<string, string> = {};
  const nodeCaptions: Record<string, { title: string; caption: string }> = {};
  const nodePauseSecByNode: Record<string, number> = {};
  const nodeIndexMap: Record<string, number> = {};

  populatedNodeIds.forEach((oldNodeId, idx) => {
    const newNodeId = idx + 1;
    nodeIndexMap[String(oldNodeId)] = newNodeId;
    nodeUrls[String(newNodeId)] = rawUrls[String(oldNodeId)];

    const caption = rawCaptions[String(oldNodeId)];
    if (caption) {
      nodeCaptions[String(newNodeId)] = { ...caption };
    }

    const pauseSec = Number(rawPauseSecByNode[String(oldNodeId)]);
    if (Number.isFinite(pauseSec)) {
      nodePauseSecByNode[String(newNodeId)] = pauseSec;
    }
  });

  const normalizedLastSelectedNode =
    input.lastSelectedNode !== null &&
    input.lastSelectedNode !== undefined &&
    Object.prototype.hasOwnProperty.call(nodeIndexMap, String(input.lastSelectedNode))
      ? nodeIndexMap[String(input.lastSelectedNode)]
      : 1;

  return {
    nodeCount: populatedNodeIds.length,
    lastSelectedNode: normalizedLastSelectedNode,
    nodeUrls,
    nodeCaptions: Object.keys(nodeCaptions).length > 0 ? nodeCaptions : undefined,
    nodePauseSecByNode: Object.keys(nodePauseSecByNode).length > 0 ? nodePauseSecByNode : undefined,
  };
}

export async function createShareFromGraphState(
  input: Pick<GraphState, "nodeCount" | "lastSelectedNode" | "nodeUrls"> & Partial<Pick<GraphState, "nodeCaptions" | "nodePauseSecByNode">>,
  meta?: { createdByUserId?: string | null; organizationId?: string | null; saved?: boolean; topic?: string | null },
): Promise<ShareState> {
  // Snapshot by creating a fresh graph, then binding a short code to it.
  const graph = await createGraph(input);

  const createdAt = new Date().toISOString();
  const createdByUserId = meta?.createdByUserId ?? null;
  const organizationId = meta?.organizationId ?? null;
  const saved = meta?.saved === true;
  const topic = meta?.topic ? String(meta.topic).trim() : null;

  if (isDbEnabled()) {
    const prisma = getPrisma();

    // Best-effort uniqueness with bounded retries.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomShareCode(8);
      try {
        const created = await prisma.share.create({
          data: { code, graphId: graph.id, createdByUserId, organizationId, saved, topic },
        });
        return {
          code: created.code,
          graphId: created.graphId,
          createdByUserId: created.createdByUserId ?? null,
          organizationId: created.organizationId ?? null,
          topic: created.topic ?? null,
          saved: created.saved === true,
          createdAt: created.createdAt.toISOString(),
        };
      } catch (err: any) {
        // Unique constraint violation: retry; otherwise bubble up.
        if (typeof err?.code === "string" && err.code === "P2002") continue;
        throw err;
      }
    }
    throw new Error("failed_to_allocate_share_code");
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomShareCode(8);
    if (shares.has(code)) continue;
    shares.set(code, { graphId: graph.id, createdAt, topic });
    return { code, graphId: graph.id, createdByUserId, organizationId, topic, saved, createdAt };
  }
  throw new Error("failed_to_allocate_share_code");
}

export async function getGraphByShareCode(
  code: string,
): Promise<(GraphState & { shareCreatedAt: string; topic: string | null }) | null> {
  if (isDbEnabled()) {
    const prisma = getPrisma();
    const share = await prisma.share.findUnique({ where: { code } });
    if (!share) return null;
    const graph = await getGraph(share.graphId);
    if (!graph) return null;
    return { ...graph, shareCreatedAt: share.createdAt.toISOString(), topic: share.topic ?? null };
  }

  const s = shares.get(code);
  if (!s) return null;
  const graph = await getGraph(s.graphId);
  if (!graph) return null;
  return { ...graph, shareCreatedAt: s.createdAt, topic: s.topic ?? null };
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeNodeUrls(raw: Record<string, string>, nodeCount: number): Record<string, string> {
  const nodeUrls: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isFinite(idx)) continue;
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const i = Math.trunc(idx);
    if (i < 1 || i > nodeCount) continue;
    nodeUrls[String(i)] = trimmed;
  }
  return nodeUrls;
}
