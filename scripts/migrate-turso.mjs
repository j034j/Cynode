import 'dotenv/config';
import { createClient } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
const migrationsDir = 'server/prisma/migrations';

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function listMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((entry) => statSync(join(migrationsDir, entry)).isDirectory() && !entry.startsWith('.'))
    .sort()
    .map((entry) => ({
      name: entry,
      path: join(migrationsDir, entry, 'migration.sql'),
    }));
}

async function tableExists(client, tableName) {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function getTableColumns(client, tableName) {
  if (!(await tableExists(client, tableName))) return new Set();
  const result = await client.execute(`PRAGMA table_info("${String(tableName).replace(/"/g, '""')}")`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableHasColumns(client, tableName, columns) {
  const existing = await getTableColumns(client, tableName);
  return columns.every((column) => existing.has(column));
}

async function ensureMigrationTable(client) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "_prisma_migrations_migration_name_key"
      ON "_prisma_migrations"("migration_name");
  `);
}

async function getAppliedMigrations(client) {
  if (!(await tableExists(client, '_prisma_migrations'))) return new Set();

  const result = await client.execute(`
    SELECT migration_name
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  `);

  return new Set(result.rows.map((row) => String(row.migration_name)));
}

async function recordMigrationSuccess(client, migrationName, hash) {
  await client.execute({
    sql: `
      INSERT INTO "_prisma_migrations" (
        "id",
        "checksum",
        "finished_at",
        "migration_name",
        "logs",
        "rolled_back_at",
        "started_at",
        "applied_steps_count"
      )
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, '', NULL, CURRENT_TIMESTAMP, 1)
      ON CONFLICT("migration_name") DO UPDATE SET
        "checksum" = excluded."checksum",
        "finished_at" = excluded."finished_at",
        "logs" = '',
        "rolled_back_at" = NULL,
        "started_at" = excluded."started_at",
        "applied_steps_count" = excluded."applied_steps_count"
    `,
    args: [randomUUID(), hash, migrationName],
  });
}

function isAlreadyAppliedError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('already exists') || text.includes('duplicate column name');
}

async function verifyMigrationState(client, migrationName) {
  switch (migrationName) {
    case '20260316112512_nodex':
      return (await tableHasColumns(client, 'Graph', ['id', 'nodeCount', 'lastSelectedNode', 'createdAt', 'updatedAt']))
        && (await tableHasColumns(client, 'Node', ['id', 'graphId', 'index', 'url', 'createdAt', 'updatedAt']));
    case '20260316114710_add_share':
      return await tableHasColumns(client, 'Share', ['code', 'graphId', 'createdAt']);
    case '20260316125216_auth_orgs':
      return (await tableHasColumns(client, 'User', ['id', 'handle', 'displayName', 'email', 'avatarUrl', 'createdAt', 'updatedAt']))
        && (await tableHasColumns(client, 'OAuthAccount', ['id', 'provider', 'providerUserId', 'userId', 'createdAt', 'updatedAt']))
        && (await tableHasColumns(client, 'Session', ['id', 'userId', 'createdAt', 'expiresAt']))
        && (await tableHasColumns(client, 'Organization', ['id', 'name', 'slug', 'customDomain', 'createdByUserId', 'createdAt', 'updatedAt']))
        && (await tableHasColumns(client, 'Membership', ['id', 'userId', 'organizationId', 'role', 'createdAt']))
        && (await tableHasColumns(client, 'Share', ['createdByUserId', 'organizationId']));
    case '20260316133820_local_auth':
      return await tableHasColumns(client, 'User', ['passwordHash']);
    case '20260316140023_saved_links':
      return await tableHasColumns(client, 'Share', ['saved']);
    case '20260316142146_share_topic':
      return await tableHasColumns(client, 'Share', ['topic']);
    case '20260316152127_add_media_assets':
      return await tableHasColumns(client, 'MediaAsset', ['id', 'shareCode', 'kind', 'nodeIndex', 'mimeType', 'sizeBytes', 'sha256', 'originalName', 'storagePath', 'createdAt']);
    case '20260316154110_add_subscriptions':
      return await tableHasColumns(client, 'Subscription', ['id', 'organizationId', 'provider', 'planKey', 'status', 'providerCustomerId', 'providerSubscriptionId', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'createdAt', 'updatedAt']);
    case '20260316160239_add_analytics_events':
      return await tableHasColumns(client, 'AnalyticsEvent', ['id', 'shareCode', 'type', 'nodeIndex', 'url', 'viewerHash', 'referrer', 'userAgent', 'createdAt']);
    case '20260316164104_add_user_subscriptions_and_usage':
      return (await tableHasColumns(client, 'UserSubscription', ['id', 'userId', 'provider', 'planKey', 'status', 'providerCustomerId', 'providerSubscriptionId', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'createdAt', 'updatedAt']))
        && (await tableHasColumns(client, 'UsageCounter', ['id', 'subjectType', 'subjectId', 'periodStart', 'creditsUsed', 'savedLinksCreated', 'mediaBytesUploaded', 'analyticsEvents', 'createdAt', 'updatedAt']));
    case '20260316220425_add_robust_analytics':
      return await tableHasColumns(client, 'AnalyticsEvent', ['browser', 'city', 'country', 'device', 'os', 'refererSource']);
    case '20260324212102_init_db':
      return (await tableHasColumns(client, 'AnalyticsEvent', ['pagePath', 'utmCampaign', 'utmContent', 'utmMedium', 'utmSource', 'utmTerm']))
        && (await tableHasColumns(client, 'Node', ['caption', 'pauseSec', 'title']));
    case '20260410153147_add_share_updated_at':
      return await tableHasColumns(client, 'Share', ['updatedAt']);
    case '20260416000000_sync':
      return true;
    default:
      return false;
  }
}

export async function runMigration() {
  if (!tursoUrl || !tursoToken) {
    throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  }

  console.log('Running Turso migration...');
  console.log('URL:', tursoUrl);

  const client = createClient({
    url: tursoUrl,
    authToken: tursoToken,
  });

  try {
    await client.execute('SELECT 1');
    await ensureMigrationTable(client);

    const applied = await getAppliedMigrations(client);
    const migrations = listMigrationFiles();

    for (const migration of migrations) {
      const sql = readFileSync(migration.path, 'utf-8');
      const hash = checksum(sql);

      if (applied.has(migration.name)) {
        console.log(`  - ${migration.name} skipped (recorded in _prisma_migrations)`);
        continue;
      }

      if (await verifyMigrationState(client, migration.name)) {
        await recordMigrationSuccess(client, migration.name, hash);
        console.log(`  OK ${migration.name} already present in schema; recorded in _prisma_migrations`);
        continue;
      }

      console.log(`Running migration: ${migration.name}...`);
      try {
        await client.executeMultiple(sql);
        await recordMigrationSuccess(client, migration.name, hash);
        console.log(`  OK ${migration.name} applied`);
      } catch (err) {
        const message = err?.message ?? String(err);
        if (isAlreadyAppliedError(message) && (await verifyMigrationState(client, migration.name))) {
          await recordMigrationSuccess(client, migration.name, hash);
          console.log(`  OK ${migration.name} verified after idempotent schema conflict; recorded in _prisma_migrations`);
          continue;
        }
        console.error(`  FAIL ${migration.name}: ${message}`);
        throw err;
      }
    }

    console.log('\nMigration complete!');
  } finally {
    client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigration().catch((err) => {
    console.error('Migration failed:', err?.message ?? err);
    process.exitCode = 1;
  });
}
