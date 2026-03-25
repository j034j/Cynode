import 'dotenv/config';
import { createClient } from '@libsql/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

if (!tursoUrl || !tursoToken) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

console.log('Running Turso migration...');
console.log('URL:', tursoUrl);

// Use a local SQLite file for Prisma CLI schema validation
// The schema expects a file:// URL for SQLite provider validation
process.env.LOCAL_DB_URL = 'file:./server/prisma/dev.db';

// Create Prisma client with libsql adapter for the actual Turso connection
const adapter = new PrismaLibSql({
  url: tursoUrl,
  authToken: tursoToken,
});

const prisma = new PrismaClient({ adapter });

try {
  // Run migrations using Prisma's programmatic API with the adapter
  console.log('Applying migrations to Turso database...');
  await prisma.$executeRawUnsafe('SELECT 1'); // Test connection
  
  // Use prisma migrate deploy logic programmatically
  // Since we're using an adapter, we need to run raw SQL migrations
  const migrationFiles = [
    '20260316112512_nodex/migration.sql',
    '20260316114710_add_share/migration.sql',
    '20260316125216_auth_orgs/migration.sql',
    '20260316133820_local_auth/migration.sql',
    '20260316140023_saved_links/migration.sql',
    '20260316142146_share_topic/migration.sql',
    '20260316152127_add_media_assets/migration.sql',
    '20260316154110_add_subscriptions/migration.sql',
    '20260316160239_add_analytics_events/migration.sql',
    '20260316164104_add_user_subscriptions_and_usage/migration.sql',
    '20260316220425_add_robust_analytics/migration.sql',
    '20260324212102_init_db/migration.sql',
  ];
  
  const { readFileSync, readdirSync } = await import('fs');
  const { join } = await import('path');
  
  for (const migration of migrationFiles) {
    const migrationPath = join('server/prisma/migrations', migration);
    try {
      const sql = readFileSync(migrationPath, 'utf-8');
      console.log(`Running migration: ${migration}...`);
      
      const statements = sql.split(';').filter(s => s.trim().length > 0);
      for (const stmt of statements) {
        if (stmt.trim()) {
          await prisma.$executeRawUnsafe(stmt);
        }
      }
      console.log(`  ✓ ${migration} applied`);
    } catch (err) {
      // Ignore "already exists" errors
      if (!err.message?.includes('already exists') && !err.message?.includes('duplicate')) {
        console.error(`  ✗ ${migration} failed:`, err.message);
      } else {
        console.log(`  ✓ ${migration} (already applied)`);
      }
    }
  }
  
  console.log('\nMigration complete!');
} catch (e) {
  console.error('Migration failed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
} finally {
  await prisma.$disconnect();
}