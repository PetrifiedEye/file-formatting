import { MigrationInterface, QueryRunner } from 'typeorm';

const TEXT_FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
const IMAGE_FORMATS = ['png', 'jpeg', 'svg'] as const;

/** The three columns typed `conversion_format`, across two tables. */
const COLUMNS: { table: string; column: string }[] = [
  { table: 'conversion_records', column: 'source_format' },
  { table: 'conversion_records', column: 'target_format' },
  { table: 'conversion_stored_files', column: 'format' },
];

/**
 * Widen `conversion_format` to carry the image formats as well.
 *
 * **No new table, no new column, no new index.** Image conversions are rows in
 * the history feature 010 already owns, because FR-024 requires them in the
 * *same* history — and the format value itself says which family an attempt
 * belongs to, so a discriminator column would be derived data able to disagree
 * with the data it is derived from.
 *
 * The type is widened by the standard transactional swap rather than
 * `ALTER TYPE … ADD VALUE`, which cannot be used in the same transaction that
 * would exercise the new values and has behaved differently across PostgreSQL
 * versions. Three columns, two tables, one transaction.
 */
export class ImageConversion1761300000000 implements MigrationInterface {
  name = 'ImageConversion1761300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.swapType(queryRunner, [...TEXT_FORMATS, ...IMAGE_FORMATS]);
  }

  /**
   * Reverse the widening — or refuse.
   *
   * Narrowing the type back would require deleting every image attempt, so this
   * counts them first and throws a message naming the count instead. A
   * migration that silently destroys a user's history to make itself reversible
   * is the worse outcome; with no image rows present it reverses cleanly.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const list = IMAGE_FORMATS.map((format) => `'${format}'`).join(', ');

    for (const { table, column } of COLUMNS) {
      const [{ count }] = (await queryRunner.query(`
        SELECT COUNT(*)::int AS count FROM "${table}"
        WHERE "${column}"::text IN (${list})
      `)) as { count: number }[];

      if (count > 0) {
        throw new Error(
          `Cannot revert ImageConversion1761300000000: ${count} row(s) in ` +
            `"${table}"."${column}" carry an image format. Reverting would ` +
            `delete that conversion history. Remove or re-key those rows ` +
            `first if the revert is genuinely intended.`,
        );
      }
    }

    await this.swapType(queryRunner, [...TEXT_FORMATS]);
  }

  /**
   * Replace `conversion_format` with a type holding exactly `values`.
   *
   * Every column is cast through `text`, which is the only cast PostgreSQL
   * offers between two enum types. None of the three carries a default, so
   * there is none to drop and restore around the swap.
   */
  private async swapType(
    queryRunner: QueryRunner,
    values: readonly string[],
  ): Promise<void> {
    const list = values.map((value) => `'${value}'`).join(', ');

    await queryRunner.query(
      `CREATE TYPE "conversion_format_new" AS ENUM (${list})`,
    );

    for (const { table, column } of COLUMNS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE "conversion_format_new"
        USING "${column}"::text::"conversion_format_new"
      `);
    }

    await queryRunner.query(`DROP TYPE "conversion_format"`);
    await queryRunner.query(
      `ALTER TYPE "conversion_format_new" RENAME TO "conversion_format"`,
    );
  }
}
