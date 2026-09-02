import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserRegistration1756730000000 implements MigrationInterface {
  name = 'UserRegistration1756730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext"`);

    await queryRunner.query(`
      CREATE TYPE "users_status_enum" AS ENUM ('pending_confirmation', 'active')
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" citext NOT NULL,
        "password_hash" varchar(255) NOT NULL,
        "status" "users_status_enum" NOT NULL DEFAULT 'pending_confirmation',
        "pending_expires_at" TIMESTAMPTZ,
        "confirmed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_users_pending" ON "users" ("status")
      WHERE "status" = 'pending_confirmation'
    `);

    await queryRunner.query(`
      CREATE TABLE "system_settings" (
        "id" smallint NOT NULL,
        "registration_confirmation_enabled" boolean NOT NULL DEFAULT false,
        "password_recovery_confirmation_enabled" boolean NOT NULL DEFAULT false,
        "sign_in_confirmation_enabled" boolean NOT NULL DEFAULT false,
        "password_min_length" smallint NOT NULL DEFAULT 8,
        "password_require_uppercase" boolean NOT NULL DEFAULT false,
        "password_require_digit" boolean NOT NULL DEFAULT false,
        "password_require_special" boolean NOT NULL DEFAULT false,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_system_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_system_settings_singleton" CHECK ("id" = 1)
      )
    `);

    await queryRunner.query(`
      INSERT INTO "system_settings" ("id") VALUES (1)
    `);

    await queryRunner.query(`
      CREATE TABLE "confirmation_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "otp_hash" varchar(64) NOT NULL,
        "link_token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts_remaining" smallint NOT NULL DEFAULT 5,
        "last_sent_at" TIMESTAMPTZ NOT NULL,
        "invalidated_at" TIMESTAMPTZ,
        "consumed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_confirmation_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_confirmation_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_confirmation_challenges_active" ON "confirmation_challenges" ("user_id")
      WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_confirmation_challenges_link_token_hash"
      ON "confirmation_challenges" ("link_token_hash")
    `);

    await queryRunner.query(`
      CREATE TYPE "registration_audit_event_type_enum" AS ENUM (
        'registration_attempt',
        'confirmation_email_sent',
        'confirmation_attempt'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "registration_audit_outcome_enum" AS ENUM ('success', 'failure')
    `);

    await queryRunner.query(`
      CREATE TABLE "registration_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_type" "registration_audit_event_type_enum" NOT NULL,
        "outcome" "registration_audit_outcome_enum" NOT NULL,
        "normalized_email" citext NOT NULL,
        "user_id" uuid,
        "ip_address" inet,
        "user_agent" text,
        "failure_reason" varchar(100),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_registration_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_registration_audit_events_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_registration_audit_email_created"
      ON "registration_audit_events" ("normalized_email", "created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_registration_audit_event_created"
      ON "registration_audit_events" ("event_type", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "registration_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "registration_audit_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "registration_audit_event_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "confirmation_challenges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "system_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_status_enum"`);
  }
}
