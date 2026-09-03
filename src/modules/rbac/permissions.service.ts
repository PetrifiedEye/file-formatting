import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccessConfigService } from './access-config.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { RbacAuditService } from './rbac-audit.service';

@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    private readonly accessConfigService: AccessConfigService,
    private readonly rbacAuditService: RbacAuditService,
  ) {}

  async list(): Promise<Permission[]> {
    return this.permissionRepository.find();
  }

  async create(
    dto: CreatePermissionDto,
    actorUserId?: string | null,
  ): Promise<Permission> {
    if (dto.actions.length === 0) {
      throw new UnprocessableEntityException('actions must be non-empty');
    }

    const existing = await this.permissionRepository.findOne({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Permission "${dto.name}" already exists`);
    }

    const permission = await this.permissionRepository.save(
      this.permissionRepository.create({
        name: dto.name,
        description: dto.description ?? null,
        actions: dto.actions,
      }),
    );

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.PERMISSION_CREATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.PERMISSION,
        entityId: permission.id,
      },
    );

    return permission;
  }

  async update(
    id: string,
    dto: UpdatePermissionDto,
    actorUserId?: string | null,
  ): Promise<Permission> {
    const permission = await this.permissionRepository.findOne({
      where: { id },
    });
    if (!permission) {
      throw new NotFoundException(`Permission ${id} not found`);
    }

    if (dto.actions !== undefined && dto.actions.length === 0) {
      throw new UnprocessableEntityException('actions must be non-empty');
    }

    if (dto.name && dto.name !== permission.name) {
      const existing = await this.permissionRepository.findOne({
        where: { name: dto.name },
      });
      if (existing) {
        throw new ConflictException(`Permission "${dto.name}" already exists`);
      }
      permission.name = dto.name;
    }

    if (dto.description !== undefined) {
      permission.description = dto.description ?? null;
    }

    if (dto.actions !== undefined) {
      permission.actions = dto.actions;
    }

    const saved = await this.permissionRepository.save(permission);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.PERMISSION_UPDATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.PERMISSION,
        entityId: saved.id,
      },
    );

    return saved;
  }

  async delete(id: string, actorUserId?: string | null): Promise<void> {
    const permission = await this.permissionRepository.findOne({
      where: { id },
    });
    if (!permission) {
      throw new NotFoundException(`Permission ${id} not found`);
    }

    const dependentGrant = await this.grantRepository.findOne({
      where: { permissionId: id },
    });
    if (dependentGrant) {
      throw new ConflictException(
        `Permission ${id} cannot be deleted: it is referenced by existing grants`,
      );
    }

    await this.permissionRepository.delete(id);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.PERMISSION_DELETED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.PERMISSION,
        entityId: id,
      },
    );
  }
}
