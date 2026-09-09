import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminUserList1760300000000 implements MigrationInterface {
  name = 'AdminUserList1760300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "last_login_at" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      UPDATE "users" AS "u"
      SET "last_login_at" = "last_login"."max_created_at"
      FROM (
        SELECT "user_id", MAX("created_at") AS "max_created_at"
        FROM "login_audit_events"
        WHERE "outcome" = 'success'
          AND "event_type" IN ('login_attempt', 'login_verification_attempt')
        GROUP BY "user_id"
      ) AS "last_login"
      WHERE "last_login"."user_id" = "u"."id"
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_created"
      ON "users" ("created_at" DESC, "id" DESC)
      WHERE "deletion_started_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_email"
      ON "users" ("email", "id")
      WHERE "deletion_started_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_users_directory_last_login"
      ON "users" ("last_login_at" DESC, "id" DESC)
      WHERE "deletion_started_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TYPE "user_directory_audit_events_outcome_enum" AS ENUM (
        'success', 'denied', 'unauthenticated', 'invalid', 'rate_limited'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_directory_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_id" uuid,
        "outcome" "user_directory_audit_events_outcome_enum" NOT NULL,
        "result_count" integer,
        "search_used" boolean,
        "status_filter_used" boolean,
        "sort_field" varchar,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_directory_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_directory_audit_actor_created"
      ON "user_directory_audit_events" ("actor_id", "created_at")
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete', 'list']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete', 'list']
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
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete']
      FROM "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'users'
    `);

    await queryRunner.query(`
      UPDATE "permissions"
      SET "actions" = ARRAY['read', 'update', 'update-email', 'delete']
      WHERE "name" = 'users'
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_user_directory_audit_actor_created"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "user_directory_audit_events"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "user_directory_audit_events_outcome_enum"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_users_directory_last_login"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_directory_email"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_users_directory_created"`,
    );

    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN "last_login_at"
    `);
  }
}
