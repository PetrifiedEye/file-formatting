import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccountDeletion1760200000000 implements MigrationInterface {
  name = 'AccountDeletion1760200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "deletion_started_at" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE TABLE "account_deletion_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "otp_hash" varchar(64) NOT NULL,
        "link_token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "last_sent_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts_remaining" smallint NOT NULL DEFAULT 5,
        "invalidated_at" TIMESTAMPTZ,
        "consumed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_deletion_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_account_deletion_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_account_deletion_challenges_active"
      ON "account_deletion_challenges" ("user_id")
      WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_account_deletion_challenges_link_token_hash"
      ON "account_deletion_challenges" ("link_token_hash")
    `);

    await queryRunner.query(`
      CREATE TYPE "account_deletion_audit_events_action_enum" AS ENUM (
        'self_delete_initiated',
        'self_delete_resent',
        'self_delete_confirmed',
        'self_delete_failed',
        'admin_delete'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "account_deletion_audit_events_outcome_enum" AS ENUM (
        'success', 'denied', 'failure', 'not_found', 'conflict'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "account_deletion_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_id" uuid NOT NULL,
        "target_id" varchar NOT NULL,
        "action" "account_deletion_audit_events_action_enum" NOT NULL,
        "outcome" "account_deletion_audit_events_outcome_enum" NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_deletion_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_account_deletion_audit_actor_created"
      ON "account_deletion_audit_events" ("actor_id", "created_at")
    `);

    // Deletion redacts the plaintext email on pre-existing login/registration
    // audit rows for the deleted user; both columns must accept NULL for that.
    await queryRunner.query(`
      ALTER TABLE "login_audit_events"
      ALTER COLUMN "normalized_email" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "registration_audit_events"
      ALTER COLUMN "normalized_email" DROP NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete']
      FROM "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'users'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = ARRAY['read', 'update', 'update-email']
      FROM "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'users'
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read', 'update', 'update-email']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(`
      ALTER TABLE "registration_audit_events"
      ALTER COLUMN "normalized_email" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "login_audit_events"
      ALTER COLUMN "normalized_email" SET NOT NULL
    `);

    await queryRunner.query(
      `DROP TABLE IF EXISTS "account_deletion_audit_events"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "account_deletion_audit_events_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "account_deletion_audit_events_action_enum"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "account_deletion_challenges"`,
    );
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN "deletion_started_at"
    `);
  }
}
