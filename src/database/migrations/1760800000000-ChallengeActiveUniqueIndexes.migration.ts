import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = [
  'confirmation_challenges',
  'login_challenges',
  'password_reset_challenges',
] as const;

/**
 * "One active challenge per user" is enforced by every service that issues a
 * challenge (invalidate the previous one, then insert), but nothing stopped
 * two concurrent requests from both passing that read and leaving two live
 * codes for the same user — each independently redeemable.
 *
 * `email_change_challenges` and `account_deletion_challenges` already carry a
 * partial UNIQUE index for this; the three older tables only had a plain
 * index. This brings them in line. Any duplicates already in the table are
 * invalidated first, newest kept, so the index can be built.
 */
export class ChallengeActiveUniqueIndexes1760800000000 implements MigrationInterface {
  name = 'ChallengeActiveUniqueIndexes1760800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`
        UPDATE "${table}" SET "invalidated_at" = now()
        WHERE "id" IN (
          SELECT "id" FROM (
            SELECT "id", row_number() OVER (
              PARTITION BY "user_id" ORDER BY "issued_at" DESC, "id" DESC
            ) AS rn
            FROM "${table}"
            WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
          ) ranked
          WHERE ranked.rn > 1
        )
      `);

      await queryRunner.query(`DROP INDEX "idx_${table}_active"`);
      await queryRunner.query(`
        CREATE UNIQUE INDEX "idx_${table}_active" ON "${table}" ("user_id")
        WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`DROP INDEX "idx_${table}_active"`);
      await queryRunner.query(`
        CREATE INDEX "idx_${table}_active" ON "${table}" ("user_id")
        WHERE "invalidated_at" IS NULL AND "consumed_at" IS NULL
      `);
    }
  }
}
