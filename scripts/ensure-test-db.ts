import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { Client } from 'pg';

/**
 * Creates the e2e test database if it doesn't already exist. Run automatically
 * via the `pretest:e2e` npm script, before Jest starts. Schema migrations are
 * NOT run here — that's handled by `POSTGRES_MIGRATIONS_RUN` on app boot.
 */
async function ensureTestDb(): Promise<void> {
  const envTestPath = path.resolve(process.cwd(), '.env.test');

  if (!fs.existsSync(envTestPath) && !process.env.POSTGRES_DB) {
    throw new Error(
      `Missing .env.test file at ${envTestPath}. Copy .env.test.example to .env.test and fill in the values (see .env.test.example).`,
    );
  }

  dotenv.config({ path: envTestPath });

  const host = process.env.POSTGRES_HOST;
  const port = Number(process.env.POSTGRES_PORT);
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;

  if (!database) {
    throw new Error(
      'POSTGRES_DB is not set. Check .env.test (see .env.test.example).',
    );
  }

  const client = new Client({
    host,
    port,
    user,
    password,
    database: 'postgres',
  });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres unreachable at ${host}:${port} — is \`docker-compose up -d postgres\` running? (${(error as Error).message})`,
    );
  }

  try {
    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );

    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database}"`);
      console.log(`Created test database "${database}".`);
    }
  } finally {
    await client.end();
  }
}

ensureTestDb().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
