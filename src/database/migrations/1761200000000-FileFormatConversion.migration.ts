import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two new tables for the file-format conversion feature. No existing table is
 * touched.
 *
 * The `CHECK` constraints are the point of interest: they encode the
 * success/failure and retention invariants in the schema rather than leaving
 * them to the call site, so a future writer cannot record a file as retained
 * when it was not (FR-026, FR-028), and cannot record a success with no format.
 *
 * Neither table has a column capable of holding file content — that is how
 * FR-023 / SC-005 are enforced.
 */
export class FileFormatConversion1761200000000 implements MigrationInterface {
  name = 'FileFormatConversion1761200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "conversion_format" AS ENUM ('csv', 'json', 'xml', 'yaml')
    `);

    await queryRunner.query(`
      CREATE TYPE "conversion_outcome" AS ENUM ('success', 'failure')
    `);

    await queryRunner.query(`
      CREATE TYPE "conversion_error_category" AS ENUM (
        'bad_request',
        'unsupported_media_type',
        'payload_too_large',
        'parse_error',
        'structure_limit_exceeded',
        'timeout',
        'internal_error'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "conversion_retention_outcome" AS ENUM (
        'not_requested', 'stored', 'failed'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversion_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "original_file_name" varchar(255) NOT NULL,
        "source_format" "conversion_format",
        "target_format" "conversion_format",
        "input_size_bytes" bigint NOT NULL,
        "output_size_bytes" integer,
        "outcome" "conversion_outcome" NOT NULL,
        "error_category" "conversion_error_category",
        "failure_reason" varchar(255),
        "retention_requested" boolean NOT NULL DEFAULT false,
        "retention_outcome" "conversion_retention_outcome" NOT NULL DEFAULT 'not_requested',
        "stored_file_id" uuid,
        "started_at" TIMESTAMPTZ(3) NOT NULL,
        "duration_ms" integer NOT NULL,
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversion_records" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversion_records_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_conversion_records_success_complete" CHECK (
          "outcome" <> 'success' OR (
            "source_format" IS NOT NULL
            AND "target_format" IS NOT NULL
            AND "output_size_bytes" IS NOT NULL
            AND "error_category" IS NULL
          )
        ),
        CONSTRAINT "CHK_conversion_records_failure_categorized" CHECK (
          "outcome" <> 'failure' OR (
            "error_category" IS NOT NULL
            AND "output_size_bytes" IS NULL
          )
        ),
        -- A link implies a stored outcome, but not the reverse. The biconditional
        -- would be stronger and is unusable: "stored_file_id" is ON DELETE SET
        -- NULL, so deleting a retained file (an expiry sweep, say) would clear
        -- the link and immediately violate it — making that FK action one that
        -- can only ever fail. The implication keeps the invariant that matters
        -- (nothing is linked unless it was stored) and reads correctly
        -- afterwards: the result *was* retained, and the file is now gone.
        CONSTRAINT "CHK_conversion_records_stored_has_file" CHECK (
          "stored_file_id" IS NULL OR "retention_outcome" = 'stored'
        ),
        CONSTRAINT "CHK_conversion_records_retention_requested" CHECK (
          "retention_outcome" = 'not_requested' OR "retention_requested" = true
        ),
        CONSTRAINT "CHK_conversion_records_stored_only_on_success" CHECK (
          "retention_outcome" <> 'stored' OR "outcome" = 'success'
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversion_stored_files" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "conversion_record_id" uuid NOT NULL,
        "format" "conversion_format" NOT NULL,
        "size_bytes" integer NOT NULL,
        "storage_path" varchar(512) NOT NULL,
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversion_stored_files" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversion_stored_files_record" UNIQUE ("conversion_record_id"),
        CONSTRAINT "FK_conversion_stored_files_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversion_stored_files_record" FOREIGN KEY ("conversion_record_id")
          REFERENCES "conversion_records"("id") ON DELETE CASCADE
      )
    `);

    // Added after both tables exist: the reference is mutual by design — the
    // record must be able to point at nothing, the file must never exist
    // without its conversion.
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      ADD CONSTRAINT "FK_conversion_records_stored_file" FOREIGN KEY ("stored_file_id")
        REFERENCES "conversion_stored_files"("id") ON DELETE SET NULL
    `);

    // "This user's history", newest first — the read path this feature is
    // written for and the SC-004 verification query.
    await queryRunner.query(`
      CREATE INDEX "idx_conversion_records_user_started"
      ON "conversion_records" ("user_id", "started_at" DESC)
    `);

    // Operational: failure rates and recent failures.
    await queryRunner.query(`
      CREATE INDEX "idx_conversion_records_outcome_started"
      ON "conversion_records" ("outcome", "started_at" DESC)
    `);

    // "My retained files", and the sweep an expiry feature would need.
    await queryRunner.query(`
      CREATE INDEX "idx_conversion_stored_files_user_created"
      ON "conversion_stored_files" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversion_records"
      DROP CONSTRAINT IF EXISTS "FK_conversion_records_stored_file"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversion_stored_files_user_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversion_records_outcome_started"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversion_records_user_started"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "conversion_stored_files"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversion_records"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "conversion_retention_outcome"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "conversion_error_category"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "conversion_outcome"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "conversion_format"`);
  }
}
