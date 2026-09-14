import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access and refresh tokens were stateless: nothing recorded that a session
 * existed, so neither logout nor a password reset could stop a 30-day refresh
 * token. `auth_sessions` is the revocation point — tokens carry its id (`sid`)
 * and every authenticated request checks the row is still live.
 *
 * Tokens issued before this migration carry no `sid` and are rejected, so it
 * signs every current session out once.
 */
export class AuthSessionRevocation1760500000000 implements MigrationInterface {
  name = 'AuthSessionRevocation1760500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "auth_sessions_revoked_reason_enum" AS ENUM (
        'logout', 'password_reset'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "revoked_at" TIMESTAMPTZ,
        "revoked_reason" "auth_sessions_revoked_reason_enum",
        CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_auth_sessions_user"
      ON "auth_sessions" ("user_id")
    `);

    // Supports both the liveness check on every request and expiry purging.
    await queryRunner.query(`
      CREATE INDEX "idx_auth_sessions_active"
      ON "auth_sessions" ("expires_at")
      WHERE "revoked_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_sessions"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "auth_sessions_revoked_reason_enum"`,
    );
  }
}
