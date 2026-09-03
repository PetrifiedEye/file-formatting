import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccessConfigService } from './access-config.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { Grant } from './entities/grant.entity';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    private readonly accessConfigService: AccessConfigService,
    private readonly rbacAuditService: RbacAuditService,
  ) {}

  async list(): Promise<Role[]> {
    return this.roleRepository.find();
  }

  async create(dto: CreateRoleDto, actorUserId?: string | null): Promise<Role> {
    const existing = await this.roleRepository.findOne({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Role "${dto.name}" already exists`);
    }

    const role = await this.roleRepository.save(
      this.roleRepository.create({
        name: dto.name,
        description: dto.description ?? null,
      }),
    );

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.ROLE_CREATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.ROLE,
        entityId: role.id,
      },
    );

    return role;
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actorUserId?: string | null,
  ): Promise<Role> {
    const role = await this.roleRepository.findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }

    if (dto.name && dto.name !== role.name) {
      const existing = await this.roleRepository.findOne({
        where: { name: dto.name },
      });
      if (existing) {
        throw new ConflictException(`Role "${dto.name}" already exists`);
      }
      role.name = dto.name;
    }

    if (dto.description !== undefined) {
      role.description = dto.description ?? null;
    }

    const saved = await this.roleRepository.save(role);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.ROLE_UPDATED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.ROLE,
        entityId: saved.id,
      },
    );

    return saved;
  }

  async delete(id: string, actorUserId?: string | null): Promise<void> {
    const role = await this.roleRepository.findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }

    const dependentGrant = await this.grantRepository.findOne({
      where: { roleId: id },
    });
    if (dependentGrant) {
      throw new ConflictException(
        `Role ${id} cannot be deleted: it is referenced by existing grants`,
      );
    }

    await this.roleRepository.delete(id);

    await this.accessConfigService.reload();
    await this.rbacAuditService.record(
      RbacAuditEventType.ROLE_DELETED,
      RbacAuditOutcome.SUCCESS,
      {
        actorUserId,
        entityType: RbacAuditEntityType.ROLE,
        entityId: id,
      },
    );
  }
}
