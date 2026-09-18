import { MigrationInterface, QueryRunner } from 'typeorm';

const SETTINGS_AUDIT_EVENT_TYPES = [
  'confirmation_policy_updated',
  'transformation_retention_updated',
] as const;

/**
 * Foundation for retained transformation-result lifecycle and downloads.
 *
 * Expiry is frozen on each history row. The settings value only supplies the
 * deadline for future rows, while result-access auditing deliberately carries
 * no foreign keys or path/content fields so it survives lifecycle cleanup.
 */
export class TransformationResultStorage1761500000000 implements MigrationInterface {
  name = 'TransformationResultStorage1761500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ADD COLUMN "expires_at" TIMESTAMPTZ(3)
    `);
    await queryRunner.query(`
      UPDATE "conversion_records"
      SET "expires_at" = "created_at" + INTERVAL '90 days'
    `);
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ALTER COLUMN "expires_at" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ADD CONSTRAINT "CHK_conversion_records_expires_after_created"
      CHECK ("expires_at" > "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_conversion_records_expires_at"
      ON "conversion_records" ("expires_at" ASC)
    `);

    await queryRunner.query(`
      ALTER TABLE "system_settings"
      ADD COLUMN "transformation_history_retention_days" smallint NOT NULL DEFAULT 90
    `);
    await queryRunner.query(`
      ALTER TABLE "system_settings"
      ADD CONSTRAINT "CHK_system_settings_transformation_retention_days"
      CHECK ("transformation_history_retention_days" BETWEEN 1 AND 3650)
    `);

    await this.swapSettingsAuditEventType(
      queryRunner,
      SETTINGS_AUDIT_EVENT_TYPES,
    );

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = array_append("actions", 'download-any'),
          "updated_at" = now()
      WHERE "name" = 'transformation-history'
        AND NOT ('download-any' = ANY ("actions"))
    `);
    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = array_append("grants"."actions", 'download-any'),
          "updated_at" = now()
      FROM "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'transformation-history'
        AND NOT ('download-any' = ANY ("grants"."actions"))
    `);

    await queryRunner.query(`
      CREATE TYPE "transformation_result_audit_action" AS ENUM (
        'save', 'download'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "transformation_result_audit_outcome" AS ENUM (
        'success',
        'conversion_failed',
        'size_exceeded',
        'storage_failed',
        'attach_failed',
        'history_unavailable',
        'denied',
        'not_found',
        'expired',
        'unavailable',
        'read_failed',
        'unauthenticated',
        'invalid',
        'rate_limited'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "transformation_result_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_user_id" uuid,
        "target_user_id" uuid,
        "conversion_record_id" uuid,
        "stored_file_id" uuid,
        "action" "transformation_result_audit_action" NOT NULL,
        "outcome" "transformation_result_audit_outcome" NOT NULL,
        "file_size_bytes" integer,
        "duration_ms" integer NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transformation_result_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_transformation_result_audit_duration_non_negative"
          CHECK ("duration_ms" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_transformation_result_audit_actor_created"
      ON "transformation_result_audit_events" ("actor_user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_transformation_result_audit_target_created"
      ON "transformation_result_audit_events" ("target_user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_transformation_result_audit_record_created"
      ON "transformation_result_audit_events" ("conversion_record_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transformation_result_audit_record_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transformation_result_audit_target_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transformation_result_audit_actor_created"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "transformation_result_audit_events"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "transformation_result_audit_outcome"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "transformation_result_audit_action"`,
    );

    // A grant created after this migration may contain only the feature-013
    // action. Remove such rows before narrowing the permission; preserve every
    // pre-existing grant/action, including feature 012's read-any grant.
    await queryRunner.query(`
      DELETE FROM "grants"
      USING "permissions"
      WHERE "grants"."permission_id" = "permissions"."id"
        AND "permissions"."name" = 'transformation-history'
        AND "grants"."actions" <@ ARRAY['download-any']::text[]
    `);
    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = array_remove("grants"."actions", 'download-any'),
          "updated_at" = now()
      FROM "permissions"
      WHERE "grants"."permission_id" = "permissions"."id"
        AND "permissions"."name" = 'transformation-history'
        AND 'download-any' = ANY ("grants"."actions")
    `);
    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = array_remove("actions", 'download-any'),
          "updated_at" = now()
      WHERE "name" = 'transformation-history'
        AND 'download-any' = ANY ("actions")
    `);

    await queryRunner.query(`
      DELETE FROM "settings_audit_events"
      WHERE "event_type"::text = 'transformation_retention_updated'
    `);
    await this.swapSettingsAuditEventType(queryRunner, [
      'confirmation_policy_updated',
    ]);

    await queryRunner.query(`
      ALTER TABLE "system_settings"
      DROP CONSTRAINT IF EXISTS "CHK_system_settings_transformation_retention_days"
    `);
    await queryRunner.query(`
      ALTER TABLE "system_settings"
      DROP COLUMN IF EXISTS "transformation_history_retention_days"
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversion_records_expires_at"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      DROP CONSTRAINT IF EXISTS "CHK_conversion_records_expires_after_created"
    `);
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      DROP COLUMN IF EXISTS "expires_at"
    `);
  }

  private async swapSettingsAuditEventType(
    queryRunner: QueryRunner,
    values: readonly string[],
  ): Promise<void> {
    const valueList = values.map((value) => `'${value}'`).join(', ');

    await queryRunner.query(`
      CREATE TYPE "settings_audit_events_event_type_enum_new"
      AS ENUM (${valueList})
    `);
    await queryRunner.query(`
      ALTER TABLE "settings_audit_events"
      ALTER COLUMN "event_type"
      TYPE "settings_audit_events_event_type_enum_new"
      USING "event_type"::text::"settings_audit_events_event_type_enum_new"
    `);
    await queryRunner.query(
      `DROP TYPE "settings_audit_events_event_type_enum"`,
    );
    await queryRunner.query(`
      ALTER TYPE "settings_audit_events_event_type_enum_new"
      RENAME TO "settings_audit_events_event_type_enum"
    `);
  }
}
