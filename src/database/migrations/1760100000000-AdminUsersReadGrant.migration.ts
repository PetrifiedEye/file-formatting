import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminUsersReadGrant1760100000000 implements MigrationInterface {
  name = 'AdminUsersReadGrant1760100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = ARRAY['read', 'update', 'update-email']
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
      SET "actions" = ARRAY['update', 'update-email']
      FROM "roles", "permissions"
      WHERE "grants"."role_id" = "roles"."id"
        AND "grants"."permission_id" = "permissions"."id"
        AND "roles"."name" = 'admin'
        AND "permissions"."name" = 'users'
    `);
  }
}
