import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TypeORM derives an enum type's name from `{table}_{column}_enum`, and these
 * two were created as `registration_audit_event_type_enum` /
 * `registration_audit_outcome_enum` — missing the plural `_events`. They are
 * the only two in the schema that do not match the derivation, so any tooling
 * that compares entities to the database reports them as drift and proposes
 * to recreate the columns.
 */
export class RegistrationAuditEnumNames1760900000000 implements MigrationInterface {
  name = 'RegistrationAuditEnumNames1760900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "registration_audit_event_type_enum" RENAME TO "registration_audit_events_event_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "registration_audit_outcome_enum" RENAME TO "registration_audit_events_outcome_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "registration_audit_events_outcome_enum" RENAME TO "registration_audit_outcome_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "registration_audit_events_event_type_enum" RENAME TO "registration_audit_event_type_enum"`,
    );
  }
}
