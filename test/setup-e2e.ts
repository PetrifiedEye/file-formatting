import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

const envTestPath = path.resolve(process.cwd(), '.env.test');

if (!fs.existsSync(envTestPath)) {
  throw new Error(
    `Missing .env.test file at ${envTestPath}. Copy .env.test.example to .env.test and fill in the values (see .env.test.example).`,
  );
}

dotenv.config({ path: envTestPath });

const devEnvPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(devEnvPath)) {
  const devEnv = dotenv.parse(fs.readFileSync(devEnvPath));

  if (devEnv.POSTGRES_DB && devEnv.POSTGRES_DB === process.env.POSTGRES_DB) {
    throw new Error(
      `.env.test's POSTGRES_DB ("${process.env.POSTGRES_DB}") is the same as dev's .env POSTGRES_DB. ` +
        'Refusing to run e2e tests against the dev database — set a different POSTGRES_DB in .env.test.',
    );
  }
}
