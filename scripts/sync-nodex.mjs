import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const srcDir = path.join(repoRoot, "public");
const dstDir = path.join(repoRoot, "nodex");

const files = [
  "index.html",
  "pricing.html",
  "pricing.js",
  "script.js",
  "play.js",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  "icon-192.png",
  "icon-512.png",
];

async function main() {
  await fs.access(dstDir);
  for (const name of files) {
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    await fs.copyFile(src, dst);
  }
  process.stdout.write(`Synced ${files.length} files to nodex/.\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
