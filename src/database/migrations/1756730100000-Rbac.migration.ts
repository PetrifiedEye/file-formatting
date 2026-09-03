import { MigrationInterface, QueryRunner } from 'typeorm';

export class Rbac1756730100000 implements MigrationInterface {
  name = 'Rbac1756730100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" citext NOT NULL,
        "description" varchar(500),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_roles_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" citext NOT NULL,
        "description" varchar(500),
        "actions" text[] NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_permissions_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "grants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        "actions" text[],
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_grants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_grants_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_grants_permission" FOREIGN KEY ("permission_id")
          REFERENCES "permissions"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_grants_role_permission"
      ON "grants" ("role_id", "permission_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_grants_role_id" ON "grants" ("role_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_grants_permission_id" ON "grants" ("permission_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "user_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_roles" PRIMARY KEY ("user_id", "role_id"),
        CONSTRAINT "FK_user_roles_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_roles_role" FOREIGN KEY ("role_id")
          REFERENCES "roles"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_roles_role_id" ON "user_roles" ("role_id")
    `);

    await queryRunner.query(`
      CREATE TYPE "rbac_audit_events_event_type_enum" AS ENUM (
        'role_created',
        'role_updated',
        'role_deleted',
        'permission_created',
        'permission_updated',
        'permission_deleted',
        'grant_created',
        'grant_updated',
        'grant_deleted',
        'config_reloaded',
        'config_reload_failed',
        'management_access_denied'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "rbac_audit_events_outcome_enum" AS ENUM ('success', 'failure')
    `);

    await queryRunner.query(`
      CREATE TYPE "rbac_audit_events_entity_type_enum" AS ENUM (
        'role', 'permission', 'grant', 'config'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "rbac_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_type" "rbac_audit_events_event_type_enum" NOT NULL,
        "outcome" "rbac_audit_events_outcome_enum" NOT NULL,
        "actor_user_id" uuid,
        "entity_type" "rbac_audit_events_entity_type_enum",
        "entity_id" uuid,
        "reason" varchar(255),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rbac_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_rbac_audit_events_actor" FOREIGN KEY ("actor_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_rbac_audit_event_created"
      ON "rbac_audit_events" ("event_type", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_rbac_audit_actor" ON "rbac_audit_events" ("actor_user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rbac_audit_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "rbac_audit_events_entity_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "rbac_audit_events_outcome_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "rbac_audit_events_event_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "grants"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "roles"`);
  }
}
