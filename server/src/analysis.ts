import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";

type ProviderKind = "local" | "cloud" | "local-runtime" | "openai-compatible";

type ProviderDescriptor = {
  id: string;
  label: string;
  kind: ProviderKind;
  available: boolean;
  isDefault: boolean;
};

export type AnalysisInput = {
  content: string;
  sourceKind: "page" | "file" | "text";
  title?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  sourceUrl?: string | null;
  provider?: string | null;
};

export type AnalysisOutput = {
  provider: string;
  sourceKind: "page" | "file" | "text";
  sourceUrl: string | null;
  title: string;
  summary: string;
  markdown: string;
  keyPoints: string[];
  metadata: Record<string, unknown>;
  extractedText: string;
};

type ActiveProvider = {
  id: string;
  label: string;
  kind: ProviderKind;
  generate: (input: AnalysisInput) => Promise<Partial<AnalysisOutput>>;
};

type AnalysisScope = {
  nodeId: number;
  shareCode?: string | null;
  graphId?: string | null;
  clientGraphKey?: string | null;
};

type AnalysisPersistedRecord = AnalysisOutput & {
  nodeId: number;
  status: "queued" | "processing" | "done" | "error";
  updatedAt: string;
  jobId: string | null;
  sourceSignature: string | null;
  error: string | null;
};

type AnalysisQueueItem = {
  id: string;
  scope: AnalysisScope;
  sourceKind: "page" | "file" | "text";
  sourceUrl?: string | null;
  title?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  provider?: string | null;
  content?: string | null;
  createdAt: string;
  sourceSignature: string;
};

const AnalyzePageSchema = z.object({
  url: z.url().max(2048),
  provider: z.string().min(1).max(64).optional(),
});

const AnalyzeContentSchema = z.object({
  content: z.string().min(1).max(250_000),
  sourceKind: z.enum(["file", "text"]).default("file"),
  title: z.string().max(160).optional(),
  mimeType: z.string().max(255).optional(),
  fileName: z.string().max(255).optional(),
  sourceUrl: z.string().max(2048).optional(),
  provider: z.string().min(1).max(64).optional(),
});

const AnalysisScopeSchema = z.object({
  nodeId: z.number().int().min(1).max(20),
  shareCode: z.string().min(4).max(32).optional(),
  graphId: z.string().uuid().optional(),
  clientGraphKey: z.string().min(1).max(160).optional(),
});

const AnalysisQueueSchema = z.object({
  scope: AnalysisScopeSchema,
  sourceKind: z.enum(["page", "file", "text"]),
  sourceUrl: z.string().max(2048).optional(),
  content: z.string().min(1).max(250_000).optional(),
  title: z.string().max(160).optional(),
  mimeType: z.string().max(255).optional(),
  fileName: z.string().max(255).optional(),
  provider: z.string().min(1).max(64).optional(),
});

const AnalysisStateQuerySchema = z.object({
  nodeId: z.coerce.number().int().min(1).max(20),
  shareCode: z.string().min(4).max(32).optional(),
  graphId: z.string().uuid().optional(),
  clientGraphKey: z.string().min(1).max(160).optional(),
});

const ProviderListResponseSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["local", "cloud", "local-runtime", "openai-compatible"]),
    available: z.boolean(),
    isDefault: z.boolean(),
  })),
});

export const AnalysisResponseSchema = z.object({
  provider: z.string(),
  sourceKind: z.enum(["page", "file", "text"]),
  sourceUrl: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  markdown: z.string(),
  keyPoints: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  extractedText: z.string(),
});

export const AnalysisRecordSchema = AnalysisResponseSchema.extend({
  nodeId: z.number().int().min(1).max(20),
  status: z.enum(["queued", "processing", "done", "error"]),
  updatedAt: z.string(),
  jobId: z.string().nullable(),
  sourceSignature: z.string().nullable(),
  error: z.string().nullable(),
});

const AnalysisStateResponseSchema = z.object({
  result: AnalysisRecordSchema.nullable(),
  job: z.object({
    id: z.string(),
    status: z.enum(["queued", "processing", "done", "error"]),
    updatedAt: z.string(),
    error: z.string().nullable(),
    nodeId: z.number().int().min(1).max(20),
    sourceSignature: z.string(),
  }).nullable(),
});

const AnalysisQueueResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(["queued", "processing", "done", "error"]),
  result: AnalysisRecordSchema.nullable(),
});

const AnalysisSyncSchema = z.object({
  analysesByNode: z.record(z.string().regex(/^\d+$/), AnalysisRecordSchema),
});

const transientJobs = new Map<string, { id: string; status: "queued" | "processing" | "done" | "error"; updatedAt: string; error: string | null; nodeId: number; sourceSignature: string }>();
const latestJobByScope = new Map<string, string>();
const queuedJobs: AnalysisQueueItem[] = [];
let queueRunning = false;

const REMOTE_BINARY_DOWNLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
const OCR_IMAGE_LIMIT_BYTES = 12 * 1024 * 1024;
const MEDIA_TRANSCRIPTION_LIMIT_BYTES = 24 * 1024 * 1024;

function analysisRootDir(): string {
  return path.resolve(process.env.ANALYSIS_ROOT ?? path.resolve("server", "data", "analysis"));
}

function scopeTarget(scope: AnalysisScope): { kind: "shares" | "graphs" | "clients"; key: string } | null {
  if (scope.shareCode) return { kind: "shares", key: scope.shareCode };
  if (scope.graphId) return { kind: "graphs", key: scope.graphId };
  if (scope.clientGraphKey) return { kind: "clients", key: scope.clientGraphKey };
  return null;
}

function safeBucketKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

async function bucketPathFor(scope: AnalysisScope): Promise<string | null> {
  const target = scopeTarget(scope);
  if (!target) return null;
  const root = analysisRootDir();
  return path.join(root, target.kind, `${safeBucketKey(target.key)}.json`);
}

async function readBucket(scope: AnalysisScope): Promise<Record<string, AnalysisPersistedRecord>> {
  const bucketPath = await bucketPathFor(scope);
  if (!bucketPath) return {};
  try {
    const raw = await fs.readFile(bucketPath, "utf8");
    const parsed = JSON.parse(raw) as { analysesByNode?: Record<string, AnalysisPersistedRecord> };
    return parsed && typeof parsed === "object" && parsed.analysesByNode ? parsed.analysesByNode : {};
  } catch (_) {
    return {};
  }
}

async function writeBucket(scope: AnalysisScope, analysesByNode: Record<string, AnalysisPersistedRecord>): Promise<void> {
  const bucketPath = await bucketPathFor(scope);
  if (!bucketPath) return;
  await fs.mkdir(path.dirname(bucketPath), { recursive: true });
  await fs.writeFile(bucketPath, JSON.stringify({ updatedAt: new Date().toISOString(), analysesByNode }, null, 2), "utf8");
}

function scopeCacheKey(scope: AnalysisScope): string {
  if (scope.shareCode) return `share:${scope.shareCode}:node:${scope.nodeId}`;
  if (scope.graphId) return `graph:${scope.graphId}:node:${scope.nodeId}`;
  if (scope.clientGraphKey) return `client:${scope.clientGraphKey}:node:${scope.nodeId}`;
  return `node:${scope.nodeId}`;
}

function buildSourceSignature(payload: { sourceKind: string; sourceUrl?: string | null; content?: string | null; mimeType?: string | null; fileName?: string | null }): string {
  const hash = crypto.createHash("sha256");
  hash.update(payload.sourceKind || "");
  hash.update("|");
  hash.update(payload.sourceUrl || "");
  hash.update("|");
  hash.update(payload.mimeType || "");
  hash.update("|");
  hash.update(payload.fileName || "");
  hash.update("|");
  hash.update(payload.content || "");
  return hash.digest("hex");
}

function analysisErrorRecord(scope: AnalysisScope, sourceKind: AnalysisInput["sourceKind"], sourceUrl: string | null, sourceSignature: string | null, error: string, jobId: string | null): AnalysisPersistedRecord {
  return {
    provider: "local",
    sourceKind,
    sourceUrl,
    title: "Analysis failed",
    summary: error,
    markdown: `## Analysis failed\n\n${error}`,
    keyPoints: [error],
    metadata: { usedAi: false },
    extractedText: "",
    nodeId: scope.nodeId,
    status: "error",
    updatedAt: new Date().toISOString(),
    jobId,
    sourceSignature,
    error,
  };
}

function toPersistedRecord(scope: AnalysisScope, result: AnalysisOutput, jobId: string | null, sourceSignature: string | null): AnalysisPersistedRecord {
  return {
    ...result,
    nodeId: scope.nodeId,
    status: "done",
    updatedAt: new Date().toISOString(),
    jobId,
    sourceSignature,
    error: null,
  };
}

async function persistRecord(scope: AnalysisScope, record: AnalysisPersistedRecord): Promise<void> {
  const bucket = await readBucket(scope);
  bucket[String(scope.nodeId)] = record;
  await writeBucket(scope, bucket);
}

async function lookupPersistedRecord(scope: AnalysisScope): Promise<AnalysisPersistedRecord | null> {
  const bucket = await readBucket(scope);
  return bucket[String(scope.nodeId)] ?? null;
}

function inferFileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split("/").filter(Boolean).pop() || "Remote file";
  } catch (_) {
    return String(url || "Remote file");
  }
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "Unknown size";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "Unknown duration";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function guessMimeType(fileName: string, fallback: string): string {
  const lowerName = String(fileName || "").toLowerCase();
  if (fallback && fallback !== "application/octet-stream") return fallback;
  if (/\.pdf$/i.test(lowerName)) return "application/pdf";
  if (/\.docx$/i.test(lowerName)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.xlsx$/i.test(lowerName)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.csv$/i.test(lowerName)) return "text/csv";
  if (/\.(ya?ml)$/i.test(lowerName)) return "text/yaml";
  if (/\.json$/i.test(lowerName)) return "application/json";
  if (/\.xml$/i.test(lowerName)) return "application/xml";
  if (/\.md$/i.test(lowerName)) return "text/markdown";
  if (/\.txt$/i.test(lowerName)) return "text/plain";
  if (/\.srt$/i.test(lowerName)) return "application/x-subrip";
  if (/\.vtt$/i.test(lowerName)) return "text/vtt";
  if (/\.png$/i.test(lowerName)) return "image/png";
  if (/\.jpe?g$/i.test(lowerName)) return "image/jpeg";
  if (/\.webp$/i.test(lowerName)) return "image/webp";
  if (/\.gif$/i.test(lowerName)) return "image/gif";
  if (/\.mp3$/i.test(lowerName)) return "audio/mpeg";
  if (/\.wav$/i.test(lowerName)) return "audio/wav";
  if (/\.m4a$/i.test(lowerName)) return "audio/mp4";
  if (/\.mp4$/i.test(lowerName)) return "video/mp4";
  if (/\.mov$/i.test(lowerName)) return "video/quicktime";
  return fallback || "application/octet-stream";
}

function isStructuredTextMime(mimeType: string, fileName: string): boolean {
  return mimeType.startsWith("text/")
    || mimeType.includes("json")
    || mimeType.includes("xml")
    || mimeType.includes("yaml")
    || /\.(txt|md|json|xml|csv|ya?ml|sql|srt|vtt)$/i.test(fileName);
}

function buildMetadataLines(sourceUrl: string, fileName: string, mimeType: string, sizeBytes: number, extras: Array<string | null | undefined> = []): string[] {
  return [
    `Remote file: ${fileName}`,
    `Type: ${mimeType || "application/octet-stream"}`,
    sizeBytes > 0 ? `Size: ${formatFileSize(sizeBytes)}` : null,
    sourceUrl ? `Source URL: ${sourceUrl}` : null,
    ...extras,
  ].filter((value): value is string => Boolean(value && String(value).trim()));
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfModule = await import("pdf-parse");
  const PDFParse = (pdfModule as { PDFParse?: new (input: { data: Buffer }) => { getText: () => Promise<{ text?: string }>; destroy: () => Promise<void> } }).PDFParse;
  if (typeof PDFParse !== "function") return "";
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return cleanWhitespace(result?.text || "");
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammothModule = await import("mammoth");
  const mammoth = mammothModule as { extractRawText?: (input: { buffer: Buffer }) => Promise<{ value?: string }> };
  if (typeof mammoth.extractRawText !== "function") return "";
  const result = await mammoth.extractRawText({ buffer });
  return cleanWhitespace(result?.value || "");
}

async function extractSpreadsheetText(buffer: Buffer): Promise<string> {
  const xlsxModule = await import("xlsx");
  const XLSX = (xlsxModule as { default?: any }).default ?? xlsxModule;
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames.slice(0, 5) : [];
  const chunks: string[] = [];
  for (const sheetName of sheets) {
    const worksheet = workbook?.Sheets?.[sheetName];
    if (!worksheet) continue;
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    if (csv && csv.trim()) {
      chunks.push(`Sheet: ${sheetName}`);
      chunks.push(csv.trim());
    }
  }
  return cleanWhitespace(chunks.join("\n\n"));
}

async function extractImageOcrText(buffer: Buffer): Promise<string> {
  const tesseractModule = await import("tesseract.js");
  const recognize = (tesseractModule as { recognize?: (input: Buffer, lang: string) => Promise<{ data?: { text?: string } }> }).recognize
    ?? (tesseractModule as { default?: { recognize?: (input: Buffer, lang: string) => Promise<{ data?: { text?: string } }> } }).default?.recognize;
  if (typeof recognize !== "function") return "";
  const result = await recognize(buffer, "eng");
  return cleanWhitespace(result?.data?.text || "");
}

async function extractMediaFacts(buffer: Buffer, mimeType: string, fileName: string): Promise<Array<string>> {
  try {
    const metadataModule = await import("music-metadata");
    const parseBuffer = (metadataModule as { parseBuffer?: Function }).parseBuffer;
    if (typeof parseBuffer !== "function") return [];
    const parsed = await parseBuffer(buffer, { mimeType, path: fileName }, { duration: true });
    const format = parsed?.format ?? {};
    const extras = [
      typeof format.duration === "number" ? `Duration: ${formatDuration(format.duration)}` : null,
      typeof format.bitrate === "number" && format.bitrate > 0 ? `Bitrate: ${Math.round(format.bitrate / 1000)} kbps` : null,
      format.codec ? `Codec: ${String(format.codec)}` : null,
      format.container ? `Container: ${String(format.container)}` : null,
      typeof format.sampleRate === "number" && format.sampleRate > 0 ? `Sample rate: ${format.sampleRate} Hz` : null,
      typeof format.numberOfChannels === "number" && format.numberOfChannels > 0 ? `Channels: ${format.numberOfChannels}` : null,
    ].filter((value): value is string => Boolean(value));
    return extras;
  } catch (_) {
    return [];
  }
}

function transcriptionConfigFor(providerId?: string | null): { provider: string; baseUrl: string; apiKey: string | null; model: string } | null {
  const selected = providerId?.trim() || env("DEFAULT_AI_PROVIDER") || env("AI_PROVIDER") || "local";
  if (selected === "openai") {
    const baseUrl = normalizeBaseUrl(env("OPENAI_BASE_URL"), "https://api.openai.com/v1");
    return { provider: selected, baseUrl, apiKey: env("OPENAI_API_KEY"), model: env("OPENAI_TRANSCRIPTION_MODEL") || "whisper-1" };
  }
  if (selected === "lmstudio") {
    const baseUrl = env("LM_STUDIO_URL");
    if (!baseUrl) return null;
    return { provider: selected, baseUrl: normalizeBaseUrl(baseUrl, "http://127.0.0.1:1234/v1"), apiKey: env("LM_STUDIO_API_KEY"), model: env("LM_STUDIO_TRANSCRIPTION_MODEL") || "whisper-1" };
  }
  if (selected === "llamacpp") {
    const baseUrl = env("LLAMACPP_URL");
    if (!baseUrl) return null;
    return { provider: selected, baseUrl: normalizeBaseUrl(baseUrl, "http://127.0.0.1:8080/v1"), apiKey: env("LLAMACPP_API_KEY"), model: env("LLAMACPP_TRANSCRIPTION_MODEL") || "whisper-1" };
  }
  return null;
}

async function transcribeRemoteMedia(buffer: Buffer, mimeType: string, fileName: string, providerId?: string | null): Promise<{ text: string; provider: string } | null> {
  const config = transcriptionConfigFor(providerId);
  if (!config) return null;
  try {
    const form = new FormData();
    const bytes = Uint8Array.from(buffer);
    form.set("model", config.model);
    form.set("response_format", "json");
    form.set("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), fileName || "media.bin");
    const response = await fetchWithTimeout(
      `${config.baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined,
        body: form,
      },
      60_000,
    );
    if (!response.ok) return null;
    const data = await response.json() as { text?: string };
    const text = cleanWhitespace(data?.text || "");
    if (!text) return null;
    return { text, provider: config.provider };
  } catch (_) {
    return null;
  }
}

async function extractRemoteFileContent(url: string, providerId?: string | null): Promise<AnalysisInput> {
  const response = await fetchWithTimeout(url, {
    headers: {
      "user-agent": "CynodeAnalysis/1.0",
      accept: "text/*,application/json,application/xml,application/xhtml+xml,application/pdf,*/*;q=0.6",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`file_fetch_${response.status}`);

  const contentLength = Number(response.headers.get("content-length") || "0") || 0;
  const sourceUrl = response.url || url;
  const fileName = inferFileNameFromUrl(sourceUrl);
  const contentType = guessMimeType(fileName, response.headers.get("content-type") || "application/octet-stream");
  const baseInput = {
    sourceKind: "file" as const,
    title: fileName,
    mimeType: contentType,
    fileName,
    sourceUrl,
  };

  if (contentType.includes("text/html") || /\.html?$/i.test(fileName)) {
    const html = await response.text();
    return {
      content: [extractMetaDescription(html), extractReadableTextFromHtml(html)].filter(Boolean).join("\n\n"),
      ...baseInput,
      title: deriveTitleFromHtml(html, sourceUrl),
    };
  }

  if (isStructuredTextMime(contentType, fileName)) {
    const text = await response.text();
    return {
      content: cleanWhitespace(text),
      ...baseInput,
    };
  }

  if (contentLength > REMOTE_BINARY_DOWNLOAD_LIMIT_BYTES) {
    return {
      content: buildMetadataLines(sourceUrl, fileName, contentType, contentLength, [
        `Cynode skipped deep extraction because the remote file exceeds ${formatFileSize(REMOTE_BINARY_DOWNLOAD_LIMIT_BYTES)}.`,
      ]).join("\n"),
      ...baseInput,
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const sizeBytes = buffer.byteLength || contentLength;

  if (contentType.includes("pdf") || /\.pdf$/i.test(fileName)) {
    const text = await extractPdfText(buffer);
    return {
      content: cleanWhitespace(text) || buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, [
        "The PDF text layer was empty or unreadable, so Cynode kept metadata only.",
      ]).join("\n"),
      ...baseInput,
    };
  }

  if (contentType.includes("wordprocessingml") || /\.docx$/i.test(fileName)) {
    const text = await extractDocxText(buffer);
    return {
      content: cleanWhitespace(text) || buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, [
        "The DOCX file did not yield readable text, so Cynode kept metadata only.",
      ]).join("\n"),
      ...baseInput,
    };
  }

  if (contentType.includes("spreadsheet") || contentType.includes("csv") || /\.(xlsx|csv)$/i.test(fileName)) {
    const text = await extractSpreadsheetText(buffer);
    return {
      content: cleanWhitespace(text) || buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, [
        "The spreadsheet could not be flattened into readable rows, so Cynode kept metadata only.",
      ]).join("\n"),
      ...baseInput,
    };
  }

  if (contentType.startsWith("image/")) {
    const ocrText = sizeBytes <= OCR_IMAGE_LIMIT_BYTES ? await extractImageOcrText(buffer) : "";
    const parts = [
      ...buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, [
        sizeBytes > OCR_IMAGE_LIMIT_BYTES ? `OCR skipped because the image exceeds ${formatFileSize(OCR_IMAGE_LIMIT_BYTES)}.` : null,
      ]),
      ocrText ? `OCR Text:\n${ocrText}` : "OCR did not detect readable text in this image.",
    ];
    return {
      content: parts.join("\n\n"),
      ...baseInput,
    };
  }

  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
    const mediaFacts = await extractMediaFacts(buffer, contentType, fileName);
    const transcription = sizeBytes <= MEDIA_TRANSCRIPTION_LIMIT_BYTES
      ? await transcribeRemoteMedia(buffer, contentType, fileName, providerId)
      : null;
    const parts = [
      ...buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, mediaFacts),
      transcription?.text
        ? `Transcript${transcription.provider ? ` (${transcription.provider})` : ""}:\n${transcription.text}`
        : sizeBytes > MEDIA_TRANSCRIPTION_LIMIT_BYTES
          ? `Transcript unavailable because the media exceeds ${formatFileSize(MEDIA_TRANSCRIPTION_LIMIT_BYTES)}.`
          : "Transcript unavailable. Configure an OpenAI-compatible transcription endpoint if you want server-side audio or video transcription.",
    ];
    return {
      content: parts.join("\n\n"),
      ...baseInput,
    };
  }

  return {
    content: buildMetadataLines(sourceUrl, fileName, contentType, sizeBytes, [
      "This remote file type does not have a built-in extractor yet, so Cynode stored metadata-only analysis.",
    ]).join("\n"),
    ...baseInput,
  };
}

async function buildInputFromQueue(item: AnalysisQueueItem): Promise<AnalysisInput> {
  if (item.content && item.content.trim()) {
    return {
      content: item.content,
      sourceKind: item.sourceKind,
      title: item.title ?? null,
      mimeType: item.mimeType ?? null,
      fileName: item.fileName ?? null,
      sourceUrl: item.sourceUrl ?? null,
      provider: item.provider ?? null,
    };
  }

  if (item.sourceKind === "page" && item.sourceUrl) {
    return { ...(await extractPageContent(item.sourceUrl)), provider: item.provider ?? null };
  }

  if (item.sourceKind === "file" && item.sourceUrl) {
    return { ...(await extractRemoteFileContent(item.sourceUrl, item.provider ?? null)), provider: item.provider ?? null };
  }

  throw new Error("queue_item_missing_content");
}

async function processAnalysisQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queuedJobs.length > 0) {
      const item = queuedJobs.shift();
      if (!item) continue;
      transientJobs.set(item.id, {
        id: item.id,
        status: "processing",
        updatedAt: new Date().toISOString(),
        error: null,
        nodeId: item.scope.nodeId,
        sourceSignature: item.sourceSignature,
      });
      try {
        const input = await buildInputFromQueue(item);
        const result = await analyze(input);
        const record = toPersistedRecord(item.scope, result, item.id, item.sourceSignature);
        await persistRecord(item.scope, record);
        transientJobs.set(item.id, {
          id: item.id,
          status: "done",
          updatedAt: record.updatedAt,
          error: null,
          nodeId: item.scope.nodeId,
          sourceSignature: item.sourceSignature,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = analysisErrorRecord(item.scope, item.sourceKind, item.sourceUrl ?? null, item.sourceSignature, message, item.id);
        await persistRecord(item.scope, failed);
        transientJobs.set(item.id, {
          id: item.id,
          status: "error",
          updatedAt: failed.updatedAt,
          error: message,
          nodeId: item.scope.nodeId,
          sourceSignature: item.sourceSignature,
        });
      }
    }
  } finally {
    queueRunning = false;
  }
}

async function getAnalysisState(scope: AnalysisScope): Promise<z.infer<typeof AnalysisStateResponseSchema>> {
  const result = await lookupPersistedRecord(scope);
  const latestJobId = latestJobByScope.get(scopeCacheKey(scope));
  const job = latestJobId ? transientJobs.get(latestJobId) ?? null : null;
  return {
    result,
    job: job ? { ...job } : null,
  };
}

async function queueAnalysis(item: z.infer<typeof AnalysisQueueSchema>): Promise<z.infer<typeof AnalysisQueueResponseSchema>> {
  const sourceSignature = buildSourceSignature({
    sourceKind: item.sourceKind,
    sourceUrl: item.sourceUrl ?? null,
    mimeType: item.mimeType ?? null,
    fileName: item.fileName ?? null,
    content: item.content ?? null,
  });
  const existing = await lookupPersistedRecord(item.scope);
  if (existing && existing.sourceSignature === sourceSignature && existing.status === "done") {
    return { jobId: existing.jobId || `cached_${item.scope.nodeId}`, status: "done", result: existing };
  }

  const key = scopeCacheKey(item.scope);
  const latestJobId = latestJobByScope.get(key);
  if (latestJobId) {
    const running = transientJobs.get(latestJobId);
    if (running && (running.status === "queued" || running.status === "processing") && running.sourceSignature === sourceSignature) {
      return { jobId: running.id, status: running.status, result: existing };
    }
  }

  const jobId = crypto.randomUUID();
  const queued: AnalysisQueueItem = {
    id: jobId,
    scope: item.scope,
    sourceKind: item.sourceKind,
    sourceUrl: item.sourceUrl ?? null,
    content: item.content ?? null,
    title: item.title ?? null,
    mimeType: item.mimeType ?? null,
    fileName: item.fileName ?? null,
    provider: item.provider ?? null,
    createdAt: new Date().toISOString(),
    sourceSignature,
  };
  latestJobByScope.set(key, jobId);
  transientJobs.set(jobId, {
    id: jobId,
    status: "queued",
    updatedAt: queued.createdAt,
    error: null,
    nodeId: item.scope.nodeId,
    sourceSignature,
  });
  queuedJobs.push(queued);
  void processAnalysisQueue();
  return { jobId, status: "queued", result: existing };
}

export async function getPersistedShareAnalyses(shareCode: string): Promise<Record<string, AnalysisPersistedRecord>> {
  return await readBucket({ shareCode, nodeId: 1 });
}

async function syncPersistedShareAnalyses(shareCode: string, analysesByNode: Record<string, AnalysisPersistedRecord>): Promise<Record<string, AnalysisPersistedRecord>> {
  await writeBucket({ shareCode, nodeId: 1 }, analysesByNode);
  return analysesByNode;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/&quot;/g, '"')
    .replaceAll(/&#39;/g, "'");
}

function cleanWhitespace(value: string): string {
  return value.replaceAll(/\r/g, "\n").replaceAll(/\t/g, " ").replaceAll(/[ \f\v]+/g, " ").replaceAll(/\n{3,}/g, "\n\n").trim();
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
}

function sentenceSplit(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function summarizeHeuristically(input: AnalysisInput): AnalysisOutput {
  const cleaned = cleanWhitespace(input.content || "");
  const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const sentences = sentenceSplit(cleaned);
  const title = clipText(
    input.title?.trim()
      || input.fileName?.trim()
      || firstNonEmptyLine(cleaned)
      || input.sourceUrl?.trim()
      || "Cynode analysis",
    120,
  );
  const summarySource = sentences.length ? sentences.slice(0, 3).join(" ") : lines.slice(0, 3).join(" ");
  const summary = clipText(summarySource || "No readable text could be extracted from this source.", 700);
  const keyPoints = (sentences.length ? sentences : lines)
    .slice(0, 5)
    .map((item) => clipText(item.replace(/^[-*•\d.\s]+/, ""), 180))
    .filter(Boolean);
  const wordCount = cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;
  const metadata: Record<string, unknown> = {
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null,
    charCount: cleaned.length,
    wordCount,
    usedAi: false,
  };
  const markdown = [
    `## ${title}`,
    "",
    summary,
    "",
    keyPoints.length ? "### Key Points" : "### Notes",
    "",
    ...(keyPoints.length ? keyPoints.map((item) => `- ${item}`) : ["- No strong key points were detected."]),
  ].join("\n");

  return {
    provider: "local",
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl ?? null,
    title,
    summary,
    markdown,
    keyPoints,
    metadata,
    extractedText: clipText(cleaned, 16_000),
  };
}

function env(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeBaseUrl(baseUrl: string | null, fallback: string): string {
  return (baseUrl ?? fallback).replace(/\/+$/, "");
}

function buildPrompt(input: AnalysisInput): string {
  const sourceLabel = input.fileName || input.title || input.sourceUrl || input.sourceKind;
  const clipped = clipText(cleanWhitespace(input.content), 18_000);
  return [
    "You analyze content for a nodegraph preview pane.",
    "Return strict JSON with keys: title, summary, keyPoints.",
    "title must be short. summary must be 2-4 sentences. keyPoints must be an array of 3-6 concise strings.",
    `Source: ${sourceLabel}`,
    input.mimeType ? `Mime-Type: ${input.mimeType}` : "",
    "Content:",
    clipped,
  ].filter(Boolean).join("\n\n");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (_) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch (_) {
      return null;
    }
  }
}

function normalizeModelResponse(providerId: string, input: AnalysisInput, rawText: string): AnalysisOutput {
  const heuristic = summarizeHeuristically(input);
  const parsed = parseJsonObject(rawText);
  const title = typeof parsed?.title === "string" && parsed.title.trim() ? clipText(parsed.title.trim(), 120) : heuristic.title;
  const summary = typeof parsed?.summary === "string" && parsed.summary.trim() ? clipText(parsed.summary.trim(), 700) : heuristic.summary;
  const keyPoints = Array.isArray(parsed?.keyPoints)
    ? parsed.keyPoints.map((item) => clipText(String(item || "").trim(), 180)).filter(Boolean).slice(0, 6)
    : heuristic.keyPoints;

  return {
    ...heuristic,
    provider: providerId,
    title,
    summary,
    keyPoints,
    markdown: [
      `## ${title}`,
      "",
      summary,
      "",
      "### Key Points",
      "",
      ...(keyPoints.length ? keyPoints.map((item) => `- ${item}`) : ["- No key points were returned by the model."]),
    ].join("\n"),
    metadata: {
      ...heuristic.metadata,
      usedAi: providerId !== "local",
      rawResponseLength: rawText.length,
    },
  };
}

async function fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1] = {}, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildProviders(): ActiveProvider[] {
  const providers: ActiveProvider[] = [
    {
      id: "local",
      label: "Local parser",
      kind: "local",
      generate: async (input) => summarizeHeuristically(input),
    },
  ];

  const geminiKey = env("GEMINI_API_KEY");
  if (geminiKey) {
    const model = env("GEMINI_MODEL") ?? "gemini-2.5-flash";
    providers.push({
      id: "gemini",
      label: `Gemini (${model})`,
      kind: "cloud",
      generate: async (input) => {
        const response = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: buildPrompt(input) }] }],
              generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
            }),
          },
        );
        if (!response.ok) throw new Error(`gemini_${response.status}`);
        const data = await response.json() as any;
        const raw = data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("\n") ?? "";
        return normalizeModelResponse("gemini", input, raw);
      },
    });
  }

  const openAiCompatibleProviders = [
    {
      id: "openai",
      label: "OpenAI-compatible",
      kind: "openai-compatible" as const,
      baseUrl: env("OPENAI_BASE_URL") ?? (env("OPENAI_API_KEY") ? "https://api.openai.com/v1" : null),
      model: env("OPENAI_MODEL") ?? "gpt-4.1-mini",
      apiKey: env("OPENAI_API_KEY"),
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      kind: "local-runtime" as const,
      baseUrl: env("LM_STUDIO_URL"),
      model: env("LM_STUDIO_MODEL") ?? "local-model",
      apiKey: env("LM_STUDIO_API_KEY"),
    },
    {
      id: "llamacpp",
      label: "llama.cpp",
      kind: "local-runtime" as const,
      baseUrl: env("LLAMACPP_URL"),
      model: env("LLAMACPP_MODEL") ?? "llama.cpp",
      apiKey: env("LLAMACPP_API_KEY"),
    },
  ];

  for (const entry of openAiCompatibleProviders) {
    if (!entry.baseUrl) continue;
    providers.push({
      id: entry.id,
      label: `${entry.label} (${entry.model})`,
      kind: entry.kind,
      generate: async (input) => {
        const baseUrl = normalizeBaseUrl(entry.baseUrl, "http://127.0.0.1:1234/v1");
        const response = await fetchWithTimeout(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(entry.apiKey ? { authorization: `Bearer ${entry.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: entry.model,
              temperature: 0.2,
              messages: [
                { role: "system", content: "Return strict JSON only." },
                { role: "user", content: buildPrompt(input) },
              ],
            }),
          },
        );
        if (!response.ok) throw new Error(`${entry.id}_${response.status}`);
        const data = await response.json() as any;
        const raw = data?.choices?.[0]?.message?.content ?? "";
        return normalizeModelResponse(entry.id, input, typeof raw === "string" ? raw : JSON.stringify(raw));
      },
    });
  }

  const ollamaUrl = env("OLLAMA_URL");
  if (ollamaUrl) {
    const model = env("OLLAMA_MODEL") ?? "llama3.2";
    providers.push({
      id: "ollama",
      label: `Ollama (${model})`,
      kind: "local-runtime",
      generate: async (input) => {
        const response = await fetchWithTimeout(
          `${normalizeBaseUrl(ollamaUrl, "http://127.0.0.1:11434")}/api/generate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              prompt: buildPrompt(input),
              stream: false,
              format: "json",
            }),
          },
        );
        if (!response.ok) throw new Error(`ollama_${response.status}`);
        const data = await response.json() as any;
        const raw = typeof data?.response === "string" ? data.response : JSON.stringify(data?.response ?? {});
        return normalizeModelResponse("ollama", input, raw);
      },
    });
  }

  return providers;
}

function getProviderDescriptors(): ProviderDescriptor[] {
  const providers = buildProviders();
  const preferred = env("DEFAULT_AI_PROVIDER") ?? env("AI_PROVIDER") ?? "local";
  const chosen = providers.some((provider) => provider.id === preferred) ? preferred : providers[0]?.id ?? "local";
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    available: true,
    isDefault: provider.id === chosen,
  }));
}

function selectProvider(providerId?: string | null): ActiveProvider {
  const providers = buildProviders();
  const preferred = providerId?.trim() || env("DEFAULT_AI_PROVIDER") || env("AI_PROVIDER") || "local";
  return providers.find((provider) => provider.id === preferred) ?? providers[0];
}

function deriveTitleFromHtml(html: string, url: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return clipText(cleanWhitespace(decodeHtmlEntities(titleMatch[1])), 120);
  try {
    return new URL(url).hostname;
  } catch (_) {
    return clipText(url, 120);
  }
}

function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    ?? html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  return match?.[1] ? cleanWhitespace(decodeHtmlEntities(match[1])) : "";
}

function extractReadableTextFromHtml(html: string): string {
  const withoutHeadNoise = html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replaceAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const text = withoutHeadNoise
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/p>/gi, "\n")
    .replaceAll(/<\/div>/gi, "\n")
    .replaceAll(/<\/section>/gi, "\n")
    .replaceAll(/<\/article>/gi, "\n")
    .replaceAll(/<li[^>]*>/gi, "\n- ")
    .replaceAll(/<[^>]+>/g, " ");
  return cleanWhitespace(decodeHtmlEntities(text));
}

async function extractPageContent(url: string): Promise<AnalysisInput> {
  const response = await fetchWithTimeout(url, {
    headers: {
      "user-agent": "CynodeAnalysis/1.0",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`page_fetch_${response.status}`);
  const contentType = response.headers.get("content-type") || "text/html";
  const body = await response.text();
  const title = deriveTitleFromHtml(body, url);
  const description = extractMetaDescription(body);
  const text = extractReadableTextFromHtml(body);
  return {
    content: [description, text].filter(Boolean).join("\n\n"),
    sourceKind: "page",
    title,
    mimeType: contentType,
    sourceUrl: url,
  };
}

async function analyze(input: AnalysisInput): Promise<AnalysisOutput> {
  const base = summarizeHeuristically(input);
  const provider = selectProvider(input.provider);
  if (provider.id === "local") return base;
  try {
    const fromProvider = await provider.generate(input);
    return {
      ...base,
      ...fromProvider,
      provider: fromProvider.provider ? String(fromProvider.provider) : provider.id,
      metadata: {
        ...base.metadata,
        ...(fromProvider.metadata && typeof fromProvider.metadata === "object" ? fromProvider.metadata : {}),
      },
      extractedText: base.extractedText,
    };
  } catch (error) {
    return {
      ...base,
      metadata: {
        ...base.metadata,
        usedAi: false,
        providerFallback: provider.id,
        providerError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function registerAnalysisRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/analysis/providers",
    {
      schema: {
        response: {
          200: ProviderListResponseSchema,
        },
      },
    },
    async () => ({ providers: getProviderDescriptors() }),
  );

  app.get<{ Querystring: z.infer<typeof AnalysisStateQuerySchema> }>(
    "/api/v1/analysis/state",
    {
      schema: {
        querystring: AnalysisStateQuerySchema,
        response: {
          200: AnalysisStateResponseSchema,
        },
      },
    },
    async (req) => await getAnalysisState({
      nodeId: req.query.nodeId,
      shareCode: req.query.shareCode ?? null,
      graphId: req.query.graphId ?? null,
      clientGraphKey: req.query.clientGraphKey ?? null,
    }),
  );

  app.post<{ Body: z.infer<typeof AnalysisQueueSchema> }>(
    "/api/v1/analysis/queue",
    {
      schema: {
        body: AnalysisQueueSchema,
        response: {
          200: AnalysisQueueResponseSchema,
        },
      },
    },
    async (req) => await queueAnalysis(req.body),
  );

  app.post<{ Params: { code: string }; Body: z.infer<typeof AnalysisSyncSchema> }>(
    "/api/v1/analysis/share/:code/sync",
    {
      schema: {
        params: z.object({ code: z.string().min(4).max(32) }),
        body: AnalysisSyncSchema,
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
    },
    async (req) => {
      await syncPersistedShareAnalyses(req.params.code, req.body.analysesByNode);
      return { ok: true };
    },
  );

  app.post<{ Body: z.infer<typeof AnalyzePageSchema> }>(
    "/api/v1/analysis/page",
    {
      schema: {
        body: AnalyzePageSchema,
        response: {
          200: AnalysisResponseSchema,
          400: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      try {
        const pageInput = await extractPageContent(req.body.url);
        const result = await analyze({ ...pageInput, provider: req.body.provider ?? null });
        return result;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "analysis_failed" });
      }
    },
  );

  app.post<{ Body: z.infer<typeof AnalyzeContentSchema> }>(
    "/api/v1/analysis/content",
    {
      schema: {
        body: AnalyzeContentSchema,
        response: {
          200: AnalysisResponseSchema,
        },
      },
    },
    async (req) => analyze({
      content: req.body.content,
      sourceKind: req.body.sourceKind,
      title: req.body.title ?? null,
      mimeType: req.body.mimeType ?? null,
      fileName: req.body.fileName ?? null,
      sourceUrl: req.body.sourceUrl ?? null,
      provider: req.body.provider ?? null,
    }),
  );
}
