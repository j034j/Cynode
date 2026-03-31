import 'dotenv/config';
import { getPrisma, closePrisma } from '../server/dist/db.js';

async function main() {
  try {
    const prisma = getPrisma();
    console.log('Prisma client initialized. Running test query...');
    // Use $queryRaw as a generic check
    const res = await prisma.$queryRaw`SELECT 1 as ok`;
    console.log('DB Test Query Result:', res);
  } catch (err) {
    console.error('DB health check failed:', err);
    process.exitCode = 1;
  } finally {
    try { await closePrisma(); } catch (_) {}
  }
}

main();
