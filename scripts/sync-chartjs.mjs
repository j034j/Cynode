import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules", "chart.js", "dist", "chart.umd.js");
const targetDir = path.join(root, "public", "vendor");
const target = path.join(targetDir, "chart.umd.js");

async function main() {
  await access(source);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  console.log(`Synced Chart.js to ${path.relative(root, target)}`);
}

main().catch((error) => {
  console.error("Failed to sync Chart.js:", error);
  process.exitCode = 1;
});
