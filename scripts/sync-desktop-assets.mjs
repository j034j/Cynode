import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const publicDir = path.join(root, "public");
const desktopAssetsDir = path.join(root, "desktop", "assets");
const buildDir = path.join(root, "build");

const icon512Path = path.join(publicDir, "icon-512.png");
const desktopIconPath = path.join(desktopAssetsDir, "icon.png");
const buildIconPngPath = path.join(buildDir, "icon.png");
const buildIconIcoPath = path.join(buildDir, "icon.ico");
const buildIconIcnsPath = path.join(buildDir, "icon.icns");

function createIcoFromPng(pngBytes, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width >= 256 ? 0 : width, 0);
  entry.writeUInt8(height >= 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBytes.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  return Buffer.concat([header, entry, pngBytes]);
}

function createIcnsFromPng(pngBytes) {
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("ic09", 0, "ascii");
  chunkHeader.writeUInt32BE(8 + pngBytes.length, 4);

  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, "ascii");
  fileHeader.writeUInt32BE(8 + chunkHeader.length + pngBytes.length, 4);

  return Buffer.concat([fileHeader, chunkHeader, pngBytes]);
}

async function main() {
  await mkdir(desktopAssetsDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  await copyFile(icon512Path, desktopIconPath);
  await copyFile(icon512Path, buildIconPngPath);

  const png512 = await readFile(icon512Path);
  const icoBytes = createIcoFromPng(png512, 256, 256);
  const icnsBytes = createIcnsFromPng(png512);
  await writeFile(buildIconIcoPath, icoBytes);
  await writeFile(buildIconIcnsPath, icnsBytes);

  console.log("Synced desktop icon assets.");
}

main().catch((error) => {
  console.error("Failed to sync desktop assets:", error);
  process.exitCode = 1;
});
