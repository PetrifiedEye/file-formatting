import dataSource from '@/database/data-source';
import { hashPassword } from '@/modules/auth/utils/password-hasher';
import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { Grant } from '@/modules/rbac/entities/grant.entity';
import { Permission } from '@/modules/rbac/entities/permission.entity';
import { Role } from '@/modules/rbac/entities/role.entity';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';

/**
 * Provisions the two accounts the Playwright e2e suite (frontend repo,
 * tests/e2e/support/seeded-users.ts) expects to already exist, since there
 * is no self-service "become admin" path by design (see
 * frontend/specs/001-auth-profile-rbac/quickstart.md).
 *
 * Idempotent — safe to run against a dev/test database repeatedly.
 * Run via `npm run seed:e2e` after `npm run migration:run`.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'AdminPassword1!';

const RBAC_USER_EMAIL =
  process.env.E2E_RBAC_USER_EMAIL ?? 'rbac-manager@example.com';
const RBAC_USER_PASSWORD =
  process.env.E2E_RBAC_USER_PASSWORD ?? 'RbacPassword1!';

async function findOrCreateActiveUser(
  userRepository: ReturnType<typeof dataSource.getRepository<User>>,
  email: string,
  password: string,
): Promise<User> {
  const existing = await userRepository.findOne({ where: { email } });
  if (existing) {
    return existing;
  }

  const passwordHash = await hashPassword(password);
  return userRepository.save(
    userRepository.create({
      email,
      passwordHash,
      status: UserStatus.ACTIVE,
      confirmedAt: new Date(),
    }),
  );
}

async function findOrCreateRole(
  roleRepository: ReturnType<typeof dataSource.getRepository<Role>>,
  name: string,
  description: string,
): Promise<Role> {
  const existing = await roleRepository.findOne({ where: { name } });
  if (existing) {
    return existing;
  }

  return roleRepository.save(roleRepository.create({ name, description }));
}

async function findOrCreatePermission(
  permissionRepository: ReturnType<
    typeof dataSource.getRepository<Permission>
  >,
  name: string,
  description: string,
  actions: string[],
): Promise<Permission> {
  const existing = await permissionRepository.findOne({ where: { name } });
  if (existing) {
    return existing;
  }

  return permissionRepository.save(
    permissionRepository.create({ name, description, actions }),
  );
}

async function ensureGrant(
  grantRepository: ReturnType<typeof dataSource.getRepository<Grant>>,
  roleId: string,
  permissionId: string,
  actions: string[],
): Promise<void> {
  const existing = await grantRepository.findOne({
    where: { roleId, permissionId },
  });
  if (existing) {
    return;
  }

  await grantRepository.save(
    grantRepository.create({ roleId, permissionId, actions }),
  );
}

async function ensureUserRole(
  userRoleRepository: ReturnType<typeof dataSource.getRepository<UserRole>>,
  userId: string,
  roleId: string,
): Promise<void> {
  const existing = await userRoleRepository.findOne({
    where: { userId, roleId },
  });
  if (existing) {
    return;
  }

  await userRoleRepository.save(userRoleRepository.create({ userId, roleId }));
}

async function seed(): Promise<void> {
  await dataSource.initialize();

  const userRepository = dataSource.getRepository(User);
  const roleRepository = dataSource.getRepository(Role);
  const permissionRepository = dataSource.getRepository(Permission);
  const grantRepository = dataSource.getRepository(Grant);
  const userRoleRepository = dataSource.getRepository(UserRole);

  try {
    const rbacPermission = await findOrCreatePermission(
      permissionRepository,
      'rbac',
      'Manage RBAC roles, permissions, and grants',
      ['manage'],
    );
    const usersPermission = await findOrCreatePermission(
      permissionRepository,
      'users',
      'Manage user accounts',
      ['read'],
    );

    // 'admin' role/grant is normally created by the RbacSeedAdmin migration;
    // re-created here defensively so this script also works standalone.
    const adminRole = await findOrCreateRole(
      roleRepository,
      'admin',
      'Bootstrap administrator role',
    );
    await ensureGrant(grantRepository, adminRole.id, rbacPermission.id, [
      'manage',
    ]);

    const rbacManagerRole = await findOrCreateRole(
      roleRepository,
      'rbac-manager',
      'E2E fixture role: RBAC management + user directory read',
    );
    await ensureGrant(
      grantRepository,
      rbacManagerRole.id,
      rbacPermission.id,
      ['manage'],
    );
    await ensureGrant(
      grantRepository,
      rbacManagerRole.id,
      usersPermission.id,
      ['read'],
    );

    const adminUser = await findOrCreateActiveUser(
      userRepository,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    );
    await ensureUserRole(userRoleRepository, adminUser.id, adminRole.id);

    const rbacManagerUser = await findOrCreateActiveUser(
      userRepository,
      RBAC_USER_EMAIL,
      RBAC_USER_PASSWORD,
    );
    await ensureUserRole(
      userRoleRepository,
      rbacManagerUser.id,
      rbacManagerRole.id,
    );

    console.log(`Seeded admin user: ${ADMIN_EMAIL}`);
    console.log(`Seeded RBAC-manager user: ${RBAC_USER_EMAIL}`);
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
