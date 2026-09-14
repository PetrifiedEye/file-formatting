import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `grants.actions = NULL` used to mean "every action of the permission",
 * resolved at authorization time. That made widening a permission a silent
 * privilege escalation: every open-ended grant picked up the new action
 * without anybody editing (or auditing) the grant.
 *
 * Every grant now enumerates what it allows. Existing open-ended rows are
 * pinned to the permission's current action list — the same access they have
 * today — and the column becomes `NOT NULL` so no new ones can appear.
 */
export class GrantActionsExplicit1760700000000 implements MigrationInterface {
  name = 'GrantActionsExplicit1760700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "grants"
      SET "actions" = "permissions"."actions"
      FROM "permissions"
      WHERE "grants"."permission_id" = "permissions"."id"
        AND ("grants"."actions" IS NULL OR cardinality("grants"."actions") = 0)
    `);

    await queryRunner.query(
      `ALTER TABLE "grants" ALTER COLUMN "actions" SET NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "grants"
      ADD CONSTRAINT "chk_grants_actions_non_empty"
      CHECK (cardinality("actions") > 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "grants" DROP CONSTRAINT IF EXISTS "chk_grants_actions_non_empty"`,
    );
    await queryRunner.query(
      `ALTER TABLE "grants" ALTER COLUMN "actions" DROP NOT NULL`,
    );
  }
}
