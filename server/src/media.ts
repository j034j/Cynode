import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";

export type StoredMedia = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  storagePath: string; // relative to media root
};

function mediaRootDir(): string {
  // Default to a repo-local folder for dev; can be overridden in prod.
  return path.resolve(process.env.MEDIA_ROOT ?? path.resolve("server", "data", "media"));
}

export async function ensureMediaRoot(): Promise<string> {
  const root = mediaRootDir();
  await fs.mkdir(root, { recursive: true });
  return root;
}

function safeSubdir(id: string): string {
  // Fan-out to avoid huge single directories.
  return id.slice(0, 2);
}

export async function storeMultipartAudio(file: MultipartFile, id?: string): Promise<StoredMedia> {
  const mediaId = id ?? crypto.randomUUID();
  const root = await ensureMediaRoot();

  const subdir = safeSubdir(mediaId);
  const rel = path.join(subdir, mediaId);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  // Stream to disk while hashing to avoid buffering large uploads in memory.
  file.file.on("data", (chunk: Buffer) => {
    sizeBytes += chunk.length;
    hash.update(chunk);
  });

  await pipeline(file.file, createWriteStream(abs));

  const sha256 = hash.digest("hex");
  const mimeType = file.mimetype || "application/octet-stream";
  const originalName = file.filename ? String(file.filename) : null;

  return { id: mediaId, mimeType, sizeBytes, sha256, originalName, storagePath: rel };
}

export async function deleteStoredMedia(storagePath: string): Promise<void> {
  const root = await ensureMediaRoot();
  const abs = path.join(root, storagePath);
  try {
    await fs.unlink(abs);
  } catch (_) {
    // Best-effort; missing file is OK.
  }
}

export async function readStoredMediaStream(storagePath: string): Promise<{ absPath: string }> {
  const root = await ensureMediaRoot();
  const abs = path.join(root, storagePath);
  return { absPath: abs };
}
