import { MigrationInterface, QueryRunner } from 'typeorm';

export class JwtSessionAuth1758000000000 implements MigrationInterface {
  name = 'JwtSessionAuth1758000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);

    await queryRunner.query(`
      ALTER TYPE "login_audit_events_event_type_enum"
      ADD VALUE 'access_check_failed'
    `);

    await queryRunner.query(`
      ALTER TYPE "login_audit_events_event_type_enum"
      ADD VALUE 'token_refresh_attempt'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop individual enum values, so 'access_check_failed'
    // and 'token_refresh_attempt' are intentionally left in
    // login_audit_events_event_type_enum.
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
  }
}
