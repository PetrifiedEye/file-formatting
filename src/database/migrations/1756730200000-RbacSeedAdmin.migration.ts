import { MigrationInterface, QueryRunner } from 'typeorm';

export class RbacSeedAdmin1756730200000 implements MigrationInterface {
  name = 'RbacSeedAdmin1756730200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "roles" ("id", "name", "description")
      VALUES (gen_random_uuid(), 'admin', 'Bootstrap administrator role')
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("id", "name", "description", "actions")
      VALUES (
        gen_random_uuid(),
        'rbac',
        'Manage RBAC roles, permissions, and grants',
        ARRAY['manage']
      )
    `);

    await queryRunner.query(`
      INSERT INTO "grants" ("id", "role_id", "permission_id", "actions")
      SELECT gen_random_uuid(), "roles"."id", "permissions"."id", NULL
      FROM "roles", "permissions"
      WHERE "roles"."name" = 'admin' AND "permissions"."name" = 'rbac'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "grants"
      USING "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'rbac'
    `);
    await queryRunner.query(`DELETE FROM "permissions" WHERE "name" = 'rbac'`);
    await queryRunner.query(`DELETE FROM "roles" WHERE "name" = 'admin'`);
  }
}
