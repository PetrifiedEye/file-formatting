import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Neither admin-directory index could serve the query it was built for.
 *
 * `idx_users_directory_last_login` was `(last_login_at DESC, id DESC)`, which
 * in Postgres means DESC NULLS FIRST. The listing orders by DESC NULLS LAST
 * (and ASC NULLS FIRST going the other way), so the planner ignored the index
 * and fell back to a full scan plus a sort. Spelling out NULLS LAST makes the
 * index match the DESC ordering exactly and the ASC one by scanning backwards.
 *
 * `idx_users_directory_email` is a plain btree on `(email, id)`, which a
 * leading-wildcard `ILIKE '%term%'` cannot use at all — every search scanned
 * the whole table. A trigram GIN index can. It is declared on `email::text`
 * because pg_trgm has no citext operator class, which is also why the query
 * had to be written against `email::text`.
 *
 * The btree on email stays: it still serves `ORDER BY email`.
 */
export class UserDirectorySearchAndSortIndexes1761000000000 implements MigrationInterface {
  name = 'UserDirectorySearchAndSortIndexes1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    await queryRunner.query(`DROP INDEX "idx_users_directory_last_login"`);
    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_last_login"
      ON "users" ("last_login_at" DESC NULLS LAST, "id" DESC)
      WHERE "deletion_started_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_email_trgm"
      ON "users" USING gin (("email"::text) gin_trgm_ops)
      WHERE "deletion_started_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_users_directory_email_trgm"`);

    await queryRunner.query(`DROP INDEX "idx_users_directory_last_login"`);
    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_last_login"
      ON "users" ("last_login_at" DESC, "id" DESC)
      WHERE "deletion_started_at" IS NULL
    `);
  }
}
