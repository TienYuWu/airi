import type { Env } from './env'

import pg from 'pg'

import { useLogger } from '@guiiai/logg'
import { migrate } from '@proj-airi/drizzle-orm-browser-migrator/pg'
import { migrations } from '@proj-airi/server-schema'
import { drizzle } from 'drizzle-orm/node-postgres'

import * as fullSchema from '../schemas'

const logger = useLogger('db')

export type Database = ReturnType<typeof createDrizzle>['db']
const MIGRATION_LOCK_KEY = 0x41495249 // "AIRI"

type DrizzleEnv = Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_POOL_IDLE_TIMEOUT_MS' | 'DB_POOL_CONNECTION_TIMEOUT_MS' | 'DB_POOL_KEEPALIVE_INITIAL_DELAY_MS'>

// NOTICE: pg is imported statically here. The OTEL instrumentation hooks are
// registered via --import ./instrumentation.mjs (preload) which runs before
// tsx loads application modules, allowing require-in-the-middle to patch pg.
export function createDrizzle(env: DrizzleEnv) {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: env.DB_POOL_KEEPALIVE_INITIAL_DELAY_MS,
  })

  pool.on('error', (err) => {
    logger.withError(err).error('Unexpected pool error on idle client')
  })

  const db = drizzle(pool, { schema: fullSchema })
  return { db, pool }
}

export async function migrateDatabase(pool: pg.Pool) {
  const client = await pool.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])

    // Check if the migration journal table exists; if it does, all migrations have already been applied
    const { rows } = await client.query<{
      journal_exists: string | null
      early_table_exists: string | null
      late_table_exists: string | null
    }>(
      `SELECT
        to_regclass('public.__drizzle_migrations') AS journal_exists,
        to_regclass('public.account') AS early_table_exists,
        to_regclass('public.oauth_client') AS late_table_exists`,
    )
    if (rows[0]?.journal_exists) {
      logger.warn('Migration journal already exists; skipping migration')
      return
    }
    // NOTICE:
    // Guard against inconsistent state where schema tables exist but the migration
    // journal was never written (e.g. crash mid-migration, journal dropped, or DB
    // seeded outside this migrator). Migration SQL has no IF NOT EXISTS guards, so
    // re-running migrations on an existing schema fails with PG error 42P07.
    //
    // We probe two sentinel tables from different ends of the migration sequence:
    //   account      — created in migration 0000 (first)
    //   oauth_client — created in migration 0008 (near-last)
    //
    // Both present  → assume all migrations ran, skip safely.
    // Only early one → partial schema; fail fast with a clear message.
    if (rows[0]?.early_table_exists && rows[0]?.late_table_exists) {
      logger.warn('Schema tables exist without migration journal; assuming already migrated, skipping')
      return
    }
    if (rows[0]?.early_table_exists) {
      throw new Error(
        'Database is in an inconsistent state: early schema tables exist but the schema is incomplete '
        + '(oauth_client is missing) and the migration journal is absent. '
        + 'Wipe the database volume and restart: docker compose down -v && docker compose up',
      )
    }

    const db = drizzle(client, { schema: fullSchema })
    await migrate(db, migrations)
  }
  finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
    finally {
      client.release()
    }
  }
}
