import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two gaps around `/admin/settings`:
 *
 * 1. It authorized on a hardcoded `roles.includes('admin')`, bypassing the
 *    grant model entirely. A `settings:manage` permission (granted to the
 *    bootstrap admin role) puts it back under RBAC.
 * 2. It mutated global auth policy without writing a single audit row.
 *    `settings_audit_events` records who changed what, with before/after values.
 */
export class SettingsPermissionAndAudit1760600000000 implements MigrationInterface {
  name = 'SettingsPermissionAndAudit1760600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "permissions" ("id", "name", "description", "actions")
      VALUES (
        gen_random_uuid(),
        'settings',
        'Read and change global confirmation and password policy',
        ARRAY['manage']
      )
      ON CONFLICT ("name") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "grants" ("id", "role_id", "permission_id", "actions")
      SELECT gen_random_uuid(), "roles"."id", "permissions"."id", ARRAY['manage']
      FROM "roles", "permissions"
      WHERE "roles"."name" = 'admin' AND "permissions"."name" = 'settings'
      ON CONFLICT ("role_id", "permission_id") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TYPE "settings_audit_events_event_type_enum" AS ENUM (
        'confirmation_policy_updated'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "settings_audit_events_outcome_enum" AS ENUM (
        'success', 'failure'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "settings_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_type" "settings_audit_events_event_type_enum" NOT NULL,
        "outcome" "settings_audit_events_outcome_enum" NOT NULL,
        "actor_user_id" uuid,
        "changes" jsonb NOT NULL DEFAULT '{}',
        "reason" varchar(255),
        "ip_address" varchar(45),
        "user_agent" varchar(512),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settings_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_settings_audit_event_created"
      ON "settings_audit_events" ("event_type", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_settings_audit_actor"
      ON "settings_audit_events" ("actor_user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "settings_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "settings_audit_events_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "settings_audit_events_event_type_enum"`,
    );

    // Every grant on the permission, not just the seeded admin one: `grants`
    // references `permissions` with ON DELETE RESTRICT, so any grant an
    // operator added since would block the DELETE below.
    await queryRunner.query(`
      DELETE FROM "grants"
      USING "permissions"
      WHERE "grants"."permission_id" = "permissions"."id"
        AND "permissions"."name" = 'settings'
    `);

    await queryRunner.query(
      `DELETE FROM "permissions" WHERE "name" = 'settings'`,
    );
  }
}
