import { MigrationInterface, QueryRunner } from 'typeorm';

export class UsersProfile1759900000000 implements MigrationInterface {
  name = 'UsersProfile1759900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD "photo_url" varchar
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("id", "name", "description", "actions")
      VALUES (
        gen_random_uuid(),
        'users',
        'View user profiles',
        ARRAY['read']
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "user_profile_audit_events_outcome_enum" AS ENUM (
        'self_view', 'privileged_view', 'denied', 'not_found'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_profile_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "viewer_id" uuid NOT NULL,
        "target_id" varchar NOT NULL,
        "outcome" "user_profile_audit_events_outcome_enum" NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_profile_audit_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_profile_audit_viewer_created"
      ON "user_profile_audit_events" ("viewer_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_profile_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "user_profile_audit_events_outcome_enum"`,
    );
    await queryRunner.query(`DELETE FROM "permissions" WHERE "name" = 'users'`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "photo_url"`);
  }
}
