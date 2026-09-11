import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `TIMESTAMPTZ` stores microseconds, but the pg driver materialises values as
 * JS `Date`, which only holds milliseconds. Keyset cursors are built from that
 * truncated value, so a cursor pointing into a microsecond-precise row either
 * re-selects the row it came from (ascending: infinite loop) or skips every
 * sibling row in the same millisecond (descending: silent data loss).
 *
 * Narrowing the cursor key columns to millisecond precision makes the
 * DB -> JS -> DB round trip lossless, which is what keyset pagination assumes.
 */
export class UserTimestampMillisecondPrecision1760400000000 implements MigrationInterface {
  name = 'UserTimestampMillisecondPrecision1760400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3),
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3),
      ALTER COLUMN "last_login_at" TYPE TIMESTAMPTZ(3)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "created_at" TYPE TIMESTAMPTZ,
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ,
      ALTER COLUMN "last_login_at" TYPE TIMESTAMPTZ
    `);
  }
}
