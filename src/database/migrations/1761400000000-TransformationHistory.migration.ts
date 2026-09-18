import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transformation history (feature 012): a read contract over the history
 * features 010 and 011 already write.
 *
 * Three things the read path needs and the schema does not yet have:
 *
 * 1. `conversion_records.transformation_type` — the family an attempt belongs
 *    to, written by the writer rather than inferred from the format columns,
 *    which are both null on a failure that precedes detection.
 * 2. `idx_conversion_records_user_created` — the access path every query in
 *    this feature shares: one user's rows, newest first. The existing
 *    `idx_conversion_records_user_started` sorts on `started_at`, which is not
 *    the column this feature pages on.
 * 3. `transformation_history_audit_events` — one row per request to either
 *    route, on every outcome. Like the other `*_audit_events` tables it keeps
 *    no FK to `users`: an access record must outlive the account it describes.
 */
export class TransformationHistory1761400000000 implements MigrationInterface {
  name = 'TransformationHistory1761400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "transformation_type" AS ENUM ('file', 'image')`,
    );

    // Added nullable, backfilled, then constrained — a NOT NULL column cannot
    // be added to a populated table without a default we would then have to
    // drop, and no default is correct for both families.
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ADD COLUMN "transformation_type" "transformation_type"
    `);

    // The one place family *is* inferred from format, because it is the only
    // information existing rows carry. Rows with neither format fall to
    // 'file', the family that existed before feature 011.
    await queryRunner.query(`
      UPDATE "conversion_records"
      SET "transformation_type" = CASE
        WHEN "source_format" IN ('png', 'jpeg', 'svg')
          OR "target_format" IN ('png', 'jpeg', 'svg')
        THEN 'image'::"transformation_type"
        ELSE 'file'::"transformation_type"
      END
    `);

    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ALTER COLUMN "transformation_type" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_conversion_records_user_created"
      ON "conversion_records" ("user_id", "created_at" DESC)
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("id", "name", "description", "actions")
      VALUES (
        gen_random_uuid(),
        'transformation-history',
        'Read any user''s file and image transformation history',
        ARRAY['read-any']
      )
      ON CONFLICT ("name") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "grants" ("id", "role_id", "permission_id", "actions")
      SELECT gen_random_uuid(), "roles"."id", "permissions"."id", ARRAY['read-any']
      FROM "roles", "permissions"
      WHERE "roles"."name" = 'admin'
        AND "permissions"."name" = 'transformation-history'
      ON CONFLICT ("role_id", "permission_id") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TYPE "transformation_history_audit_outcome" AS ENUM (
        'success', 'denied', 'not_found', 'unauthenticated', 'invalid', 'rate_limited'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "transformation_history_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        -- Nullable, though almost every row has one: a 401 is audited too
        -- (FR-017) and no caller was ever identified on that path. Same
        -- reason user_directory_audit_events.actor_id is nullable.
        "actor_user_id" uuid,
        "target_user_id" uuid,
        "outcome" "transformation_history_audit_outcome" NOT NULL,
        "result_count" integer,
        "type_filter_used" boolean NOT NULL DEFAULT false,
        "source_format_filter_used" boolean NOT NULL DEFAULT false,
        "target_format_filter_used" boolean NOT NULL DEFAULT false,
        "status_filter_used" boolean NOT NULL DEFAULT false,
        "date_range_filter_used" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transformation_history_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_transformation_history_audit_actor_created"
      ON "transformation_history_audit_events" ("actor_user_id", "created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_transformation_history_audit_target_created"
      ON "transformation_history_audit_events" ("target_user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transformation_history_audit_target_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transformation_history_audit_actor_created"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "transformation_history_audit_events"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "transformation_history_audit_outcome"`,
    );

    // Every grant on the permission, not just the seeded admin one: `grants`
    // references `permissions` with ON DELETE RESTRICT, so any grant an
    // operator added since would block the DELETE below.
    await queryRunner.query(`
      DELETE FROM "grants"
      USING "permissions"
      WHERE "grants"."permission_id" = "permissions"."id"
        AND "permissions"."name" = 'transformation-history'
    `);

    await queryRunner.query(
      `DELETE FROM "permissions" WHERE "name" = 'transformation-history'`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversion_records_user_created"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ALTER COLUMN "transformation_type" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      DROP COLUMN "transformation_type"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "transformation_type"`);
  }
}
