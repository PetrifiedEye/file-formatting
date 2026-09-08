import { MigrationInterface, QueryRunner } from 'typeorm';

export class EmailChangeAndProfileUpdate1760000000000 implements MigrationInterface {
  name = 'EmailChangeAndProfileUpdate1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_change_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "new_email" citext NOT NULL,
        "otp_hash" varchar(64) NOT NULL,
        "link_token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "last_sent_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts_remaining" smallint NOT NULL DEFAULT 5,
        "invalidated_at" TIMESTAMPTZ,
        "consumed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_change_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_change_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_email_change_challenges_active"
      ON "email_change_challenges" ("user_id")
      WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_email_change_challenges_link_token_hash"
      ON "email_change_challenges" ("link_token_hash")
    `);

    await queryRunner.query(`
      CREATE TYPE "profile_audit_events_action_enum" AS ENUM (
        'profile_update',
        'email_change_initiated',
        'email_change_sent',
        'email_change_resent',
        'email_change_confirmed',
        'email_change_failed',
        'email_change_expired',
        'admin_email_update'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "profile_audit_events_outcome_enum" AS ENUM (
        'success', 'denied', 'failure', 'not_found'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "profile_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_id" uuid NOT NULL,
        "target_id" varchar NOT NULL,
        "action" "profile_audit_events_action_enum" NOT NULL,
        "outcome" "profile_audit_events_outcome_enum" NOT NULL,
        "fields" text[] NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_profile_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_profile_audit_actor_created"
      ON "profile_audit_events" ("actor_id", "created_at")
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read', 'update', 'update-email']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(`
      INSERT INTO "grants" ("id", "role_id", "permission_id", "actions")
      SELECT gen_random_uuid(), "roles"."id", "permissions"."id",
        ARRAY['update', 'update-email']
      FROM "roles", "permissions"
      WHERE "roles"."name" = 'admin' AND "permissions"."name" = 'users'
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "grants"
      USING "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'users'
        AND "grants"."actions" = ARRAY['update', 'update-email']
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "profile_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "profile_audit_events_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "profile_audit_events_action_enum"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "email_change_challenges"`);
  }
}
