import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assigning and revoking `user_roles` had no endpoint, so every membership
 * change was made with direct SQL and left no trace in `rbac_audit_events` —
 * the one kind of RBAC change with no audit trail at all. These event types
 * back the new `/rbac/roles/:roleId/members` routes.
 */
export class RoleMembershipAudit1761100000000 implements MigrationInterface {
  name = 'RoleMembershipAudit1761100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "rbac_audit_events_event_type_enum" ADD VALUE IF NOT EXISTS 'role_membership_granted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "rbac_audit_events_event_type_enum" ADD VALUE IF NOT EXISTS 'role_membership_revoked'`,
    );
    await queryRunner.query(
      `ALTER TYPE "rbac_audit_events_entity_type_enum" ADD VALUE IF NOT EXISTS 'membership'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot remove a value from an enum type without rewriting it
    // and every column that uses it. The added values are additive and inert
    // once the routes are gone, so the down migration intentionally no-ops.
  }
}
