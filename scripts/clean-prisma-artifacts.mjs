import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const targets = [
  path.join(repoRoot, 'node_modules', '.prisma', 'client'),
  path.join(repoRoot, 'server', 'generated', 'prisma-client'),
];

for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`[PrismaClean] Removed ${target}`);
}
