import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { AccessConfigService } from './access-config.service';
import { CreateGrantDto } from './dto/create-grant.dto';
import { UpdateGrantDto } from './dto/update-grant.dto';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';

@Injectable()
export class GrantsService {
  constructor(
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    private readonly accessConfigService: AccessConfigService,
    private readonly rbacAuditService: RbacAuditService,
  ) {}

  async list(roleId?: string, permissionId?: string): Promise<Grant[]> {
    return this.grantRepository.find({
      where: {
        ...(roleId ? { roleId } : {}),
        ...(permissionId ? { permissionId } : {}),
      },
    });
  }

  @Transactional()
  async create(
    dto: CreateGrantDto,
    actorUserId?: string | null,
  ): Promise<Grant> {
    const role = await this.roleRepository.findOne({
      where: { id: dto.roleId },
    });
    if (!role) {
      throw new NotFoundException(`Role ${dto.roleId} not found`);
    }

    const permission = await this.permissionRepository.findOne({
      where: { id: dto.permissionId },
    });
    if (!permission) {
      throw new NotFoundException(`Permission ${dto.permissionId} not found`);
    }

    this.assertActionsSubset(dto.actions, permission.actions);

    const existing = await this.grantRepository.findOne({
      where: { roleId: dto.roleId, permissionId: dto.permissionId },
    });
    if (existing) {
      throw new ConflictException(
        `A grant for role ${dto.roleId} and permission ${dto.permissionId} already exists`,
      );
    }

    const grant = await this.grantRepository.save(
      this.grantRepository.create({
        roleId: dto.roleId,
        permissionId: dto.permissionId,
        actions: dto.actions && dto.actions.length > 0 ? dto.actions : null,
      }),
    );

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.GRANT_CREATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.GRANT,
        entityId: grant.id,
      },
    );

    return grant;
  }

  @Transactional()
  async update(
    id: string,
    dto: UpdateGrantDto,
    actorUserId?: string | null,
  ): Promise<Grant> {
    const grant = await this.grantRepository.findOne({ where: { id } });
    if (!grant) {
      throw new NotFoundException(`Grant ${id} not found`);
    }

    if (dto.actions !== undefined) {
      const permission = await this.permissionRepository.findOne({
        where: { id: grant.permissionId },
      });
      if (!permission) {
        throw new NotFoundException(
          `Permission ${grant.permissionId} not found`,
        );
      }

      this.assertActionsSubset(dto.actions, permission.actions);
      grant.actions = dto.actions.length > 0 ? dto.actions : null;
    }

    const saved = await this.grantRepository.save(grant);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.GRANT_UPDATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.GRANT,
        entityId: saved.id,
      },
    );

    return saved;
  }

  async delete(id: string, actorUserId?: string | null): Promise<void> {
    const grant = await this.grantRepository.findOne({ where: { id } });
    if (!grant) {
      throw new NotFoundException(`Grant ${id} not found`);
    }

    await this.grantRepository.delete(id);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.GRANT_DELETED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.GRANT,
        entityId: id,
      },
    );
  }

  private assertActionsSubset(
    actions: string[] | undefined,
    permissionActions: string[],
  ): void {
    if (!actions || actions.length === 0) {
      return;
    }

    const allowed = new Set(permissionActions);
    const invalid = actions.filter((action) => !allowed.has(action));
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(
        `actions [${invalid.join(', ')}] are not part of the permission's actions`,
      );
    }
  }
}
