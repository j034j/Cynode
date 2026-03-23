import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function isWindows() {
  return process.platform === "win32";
}

function exec(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

async function main() {
  if (!isWindows()) return;

  const nm = path.join(repoRoot, "node_modules");
  const prismaClientPkg = path.join(nm, "@prisma", "client");
  const expected = path.join(prismaClientPkg, ".prisma");
  const generated = path.join(nm, ".prisma");

  if (!(await exists(prismaClientPkg)) || !(await exists(generated))) return;
  if (await exists(expected)) return;

  // Prefer a junction: cheap and keeps things in sync.
  try {
    await exec("cmd", ["/c", "mklink", "/J", expected, generated], { windowsHide: true });
    return;
  } catch (_) {
    // Fall back to copy if junction fails (policy restrictions etc).
  }

  const src = path.join(generated, "client");
  const dst = path.join(expected, "client");
  if (await exists(src)) await copyDir(src, dst);
}

main().catch((err) => {
  // Never fail install; this is a best-effort Windows compatibility fix.
  try {
    const msg = err?.message ? String(err.message) : String(err);
    fs.writeFileSync(path.join(repoRoot, "prisma-postinstall-warn.log"), msg);
  } catch {}
});

