import { MigrationInterface, QueryRunner } from 'typeorm';

const PREVIOUS_CATEGORIES = [
  'bad_request',
  'unsupported_media_type',
  'payload_too_large',
  'parse_error',
  'structure_limit_exceeded',
  'timeout',
  'internal_error',
] as const;

/**
 * Adds `service_busy` to `conversion_error_category`: a conversion refused
 * because the bounded queue in front of the conversion workers was full.
 *
 * Its own category rather than `timeout`, because it is not one — the request
 * was turned away before any work started, and a client should retry it.
 */
export class ConversionServiceBusyCategory1761600000000 implements MigrationInterface {
  name = 'ConversionServiceBusyCategory1761600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "conversion_error_category" ADD VALUE IF NOT EXISTS 'service_busy'
    `);
  }

  /**
   * Postgres cannot drop an enum value, so the type is rebuilt without it.
   * Rows that recorded `service_busy` fall back to `timeout`, the nearest
   * previous meaning: the request was not served in time.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "conversion_error_category" RENAME TO "conversion_error_category_old"
    `);
    await queryRunner.query(`
      CREATE TYPE "conversion_error_category" AS ENUM (${PREVIOUS_CATEGORIES.map(
        (category) => `'${category}'`,
      ).join(', ')})
    `);
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ALTER COLUMN "error_category" TYPE "conversion_error_category"
      USING (
        CASE "error_category"::text
          WHEN 'service_busy' THEN 'timeout'
          ELSE "error_category"::text
        END
      )::"conversion_error_category"
    `);
    await queryRunner.query(`DROP TYPE "conversion_error_category_old"`);
  }
}
