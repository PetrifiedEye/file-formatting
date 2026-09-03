import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessConfigService } from './access-config.service';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import {
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';

describe('AccessConfigService', () => {
  let service: AccessConfigService;

  let roles: Partial<Role>[];
  let permissions: Partial<Permission>[];
  let grants: Partial<Grant>[];

  const roleRepository = { find: jest.fn(() => Promise.resolve(roles)) };
  const permissionRepository = {
    find: jest.fn(() => Promise.resolve(permissions)),
  };
  const grantRepository = { find: jest.fn(() => Promise.resolve(grants)) };
  const rbacAuditService = { record: jest.fn().mockResolvedValue(undefined) };

  const roleAdmin: Role = {
    id: 'role-admin',
    name: 'admin',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const roleEditor: Role = {
    id: 'role-editor',
    name: 'editor',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const permissionDocs: Permission = {
    id: 'perm-docs',
    name: 'docs',
    description: null,
    actions: ['read', 'write'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    roles = [];
    permissions = [];
    grants = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessConfigService,
        { provide: getRepositoryToken(Role), useValue: roleRepository },
        {
          provide: getRepositoryToken(Permission),
          useValue: permissionRepository,
        },
        { provide: getRepositoryToken(Grant), useValue: grantRepository },
        { provide: RbacAuditService, useValue: rbacAuditService },
      ],
    }).compile();

    service = module.get(AccessConfigService);
  });

  it('denies everything before any snapshot is loaded (empty config)', () => {
    expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(false);
  });

  it('allows a full-permission grant (no actions restriction) for every action', async () => {
    roles = [roleAdmin];
    permissions = [permissionDocs];
    grants = [
      { roleId: roleAdmin.id, permissionId: permissionDocs.id, actions: null },
    ];

    await service.onModuleInit();

    expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(true);
    expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(true);
  });

  it('allows only the scoped actions for an action-scoped grant', async () => {
    roles = [roleAdmin];
    permissions = [permissionDocs];
    grants = [
      {
        roleId: roleAdmin.id,
        permissionId: permissionDocs.id,
        actions: ['read'],
      },
    ];

    await service.onModuleInit();

    expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(true);
    expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(false);
  });

  it('unions grants across multiple roles held by the same user', async () => {
    roles = [roleAdmin, roleEditor];
    permissions = [permissionDocs];
    grants = [
      {
        roleId: roleEditor.id,
        permissionId: permissionDocs.id,
        actions: ['write'],
      },
    ];

    await service.onModuleInit();

    expect(service.hasPermission(['admin', 'editor'], 'docs', 'write')).toBe(
      true,
    );
    expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(false);
  });

  it('denies an unknown permission entirely', async () => {
    roles = [roleAdmin];
    permissions = [permissionDocs];
    grants = [
      { roleId: roleAdmin.id, permissionId: permissionDocs.id, actions: null },
    ];

    await service.onModuleInit();

    expect(service.hasPermission(['admin'], 'unknown', 'read')).toBe(false);
  });

  it('denies a role the user does not hold', async () => {
    roles = [roleAdmin];
    permissions = [permissionDocs];
    grants = [
      { roleId: roleAdmin.id, permissionId: permissionDocs.id, actions: null },
    ];

    await service.onModuleInit();

    expect(service.hasPermission(['editor'], 'docs', 'read')).toBe(false);
  });

  describe('reload()', () => {
    it('reflects an updated grant immediately, without a restart', async () => {
      roles = [roleAdmin];
      permissions = [permissionDocs];
      grants = [
        {
          roleId: roleAdmin.id,
          permissionId: permissionDocs.id,
          actions: ['read'],
        },
      ];

      await service.onModuleInit();
      expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(false);

      grants = [
        {
          roleId: roleAdmin.id,
          permissionId: permissionDocs.id,
          actions: null,
        },
      ];
      await service.reload();

      expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(true);
      expect(rbacAuditService.record).toHaveBeenCalledWith(
        RbacAuditEventType.CONFIG_RELOADED,
        RbacAuditOutcome.SUCCESS,
        expect.any(Object),
      );
    });

    it('keeps the previous snapshot and logs a failure when the DB read fails', async () => {
      roles = [roleAdmin];
      permissions = [permissionDocs];
      grants = [
        {
          roleId: roleAdmin.id,
          permissionId: permissionDocs.id,
          actions: null,
        },
      ];

      await service.onModuleInit();
      expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(true);

      roleRepository.find.mockRejectedValueOnce(new Error('db unavailable'));
      await service.reload();

      expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(true);
      expect(rbacAuditService.record).toHaveBeenCalledWith(
        RbacAuditEventType.CONFIG_RELOAD_FAILED,
        RbacAuditOutcome.FAILURE,
        expect.any(Object),
      );
    });

    it('narrows a grant to the permission current actions on reload', async () => {
      roles = [roleAdmin];
      permissions = [permissionDocs];
      grants = [
        {
          roleId: roleAdmin.id,
          permissionId: permissionDocs.id,
          actions: ['read', 'write'],
        },
      ];

      await service.onModuleInit();
      expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(true);

      permissions = [{ ...permissionDocs, actions: ['read'] }];
      await service.reload();

      expect(service.hasPermission(['admin'], 'docs', 'write')).toBe(false);
      expect(service.hasPermission(['admin'], 'docs', 'read')).toBe(true);
    });
  });
});
