import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthLogin1757000000000 implements MigrationInterface {
  name = 'AuthLogin1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "failed_login_attempts" smallint NOT NULL DEFAULT 0,
      ADD COLUMN "locked_until" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "invalidated_at" TIMESTAMPTZ,
        "ip_address" inet,
        "user_agent" text,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sessions_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_sessions_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_sessions_active" ON "sessions" ("user_id")
      WHERE "invalidated_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "login_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "otp_hash" varchar(64) NOT NULL,
        "link_token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts_remaining" smallint NOT NULL DEFAULT 5,
        "invalidated_at" TIMESTAMPTZ,
        "consumed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_login_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_login_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_login_challenges_active" ON "login_challenges" ("user_id")
      WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_login_challenges_link_token_hash"
      ON "login_challenges" ("link_token_hash")
    `);

    await queryRunner.query(`
      CREATE TABLE "password_reset_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "otp_hash" varchar(64) NOT NULL,
        "link_token_hash" varchar(64) NOT NULL,
        "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts_remaining" smallint NOT NULL DEFAULT 5,
        "invalidated_at" TIMESTAMPTZ,
        "consumed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_password_reset_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_password_reset_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_password_reset_challenges_active"
      ON "password_reset_challenges" ("user_id")
      WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_password_reset_challenges_link_token_hash"
      ON "password_reset_challenges" ("link_token_hash")
    `);

    await queryRunner.query(`
      CREATE TYPE "login_audit_events_event_type_enum" AS ENUM (
        'login_attempt',
        'login_verification_attempt',
        'logout',
        'password_reset_requested',
        'password_reset_attempt'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "login_audit_events_outcome_enum" AS ENUM (
        'success', 'failure', 'locked_out'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "login_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_type" "login_audit_events_event_type_enum" NOT NULL,
        "outcome" "login_audit_events_outcome_enum" NOT NULL,
        "normalized_email" citext NOT NULL,
        "user_id" uuid,
        "ip_address" inet,
        "user_agent" text,
        "failure_reason" varchar(100),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_login_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_login_audit_events_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_login_audit_email_created"
      ON "login_audit_events" ("normalized_email", "created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_login_audit_event_created"
      ON "login_audit_events" ("event_type", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "login_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "login_audit_events_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "login_audit_events_event_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_challenges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "login_challenges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN "locked_until",
      DROP COLUMN "failed_login_attempts"
    `);
  }
}
