import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserRole } from '../../src/modules/rbac/entities/user-role.entity';

/**
 * Test-only stand-in for a real authentication layer (none exists yet — see
 * research.md "Current-user resolution seam"). Resolves `request.user` from an
 * `x-test-user-id` header by reading the user's actual roles out of `user_roles`,
 * so seeded grants take effect without hardcoding generated role names in tests.
 *
 * Registered as a Fastify `onRequest` hook (rather than Nest/Express-style
 * middleware) because with the Fastify adapter, `consumer.apply(...)`
 * middleware only sees the raw `req`/`res`, not the wrapped `FastifyRequest`
 * that `PermissionGuard` reads via `switchToHttp().getRequest()`.
 */
export function attachRbacTestAuth(
  app: INestApplication,
  moduleFixture: TestingModule,
): void {
  const userRoleRepository: Repository<UserRole> = moduleFixture.get(
    getRepositoryToken(UserRole),
  );

  const fastifyInstance = app.getHttpAdapter().getInstance() as {
    addHook: (name: string, handler: (request: any) => Promise<void>) => void;
  };

  fastifyInstance.addHook('onRequest', async (request: any) => {
    const userId = request.headers['x-test-user-id'];
    if (userId) {
      const memberships = await userRoleRepository.find({
        where: { userId: String(userId) },
        relations: ['role'],
      });
      request.user = {
        id: String(userId),
        roles: memberships.map((m) => m.role.name),
      };
    }
  });
}
