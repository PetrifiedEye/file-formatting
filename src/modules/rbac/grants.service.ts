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
import { RbacSelfLockoutService } from './rbac-self-lockout.service';

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
    private readonly selfLockoutService: RbacSelfLockoutService,
  ) {}

  async list(roleId?: string, permissionId?: string): Promise<Grant[]> {
    return this.grantRepository.find({
      where: {
        ...(roleId ? { roleId } : {}),
        ...(permissionId ? { permissionId } : {}),
      },
    });
  }

  async create(
    dto: CreateGrantDto,
    actorUserId?: string | null,
  ): Promise<Grant> {
    const grant = await this.persistCreate(dto);

    await this.publish(
      RbacAuditEventType.GRANT_CREATED,
      grant.id,
      actorUserId ?? null,
    );

    return grant;
  }

  async update(
    id: string,
    dto: UpdateGrantDto,
    actorUserId?: string | null,
  ): Promise<Grant> {
    if (dto.actions !== undefined) {
      this.assertActionsPresent(dto.actions);
      await this.selfLockoutService.assertRetainsControl(actorUserId, {
        kind: 'grant-actions',
        grantId: id,
        actions: dto.actions,
      });
    }

    const saved = await this.persistUpdate(id, dto);

    await this.publish(
      RbacAuditEventType.GRANT_UPDATED,
      saved.id,
      actorUserId ?? null,
    );

    return saved;
  }

  async delete(id: string, actorUserId?: string | null): Promise<void> {
    const grant = await this.grantRepository.findOne({ where: { id } });
    if (!grant) {
      throw new NotFoundException(`Grant ${id} not found`);
    }

    await this.selfLockoutService.assertRetainsControl(actorUserId, {
      kind: 'grant-deleted',
      grantId: id,
    });

    await this.grantRepository.delete(id);

    await this.publish(
      RbacAuditEventType.GRANT_DELETED,
      id,
      actorUserId ?? null,
    );
  }

  // Only the row write is transactional. `reload()` and the audit row have to
  // run after the commit: inside the transaction, `reload()` reads uncommitted
  // grants through the transaction's runner and publishes them to the shared
  // in-memory snapshot, where a later rollback cannot take them back.
  @Transactional()
  private async persistCreate(dto: CreateGrantDto): Promise<Grant> {
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

    if (dto.actions !== undefined) {
      this.assertActionsPresent(dto.actions);
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

    return this.grantRepository.save(
      this.grantRepository.create({
        roleId: dto.roleId,
        permissionId: dto.permissionId,
        // Omitting `actions` means "everything the permission allows *today*".
        // It is recorded as an explicit list rather than left unset, so a later
        // action added to the permission does not widen this grant behind the
        // administrator's back.
        actions: dto.actions ?? [...permission.actions],
      }),
    );
  }

  @Transactional()
  private async persistUpdate(id: string, dto: UpdateGrantDto): Promise<Grant> {
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

      this.assertActionsPresent(dto.actions);
      this.assertActionsSubset(dto.actions, permission.actions);
      grant.actions = dto.actions;
    }

    return this.grantRepository.save(grant);
  }

  private async publish(
    eventType: RbacAuditEventType,
    grantId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.accessConfigService.reload();
    await this.rbacAuditService.record(eventType, RbacAuditOutcome.SUCCESS, {
      actorUserId,
      entityType: RbacAuditEntityType.GRANT,
      entityId: grantId,
    });
  }

  /**
   * An empty list used to be stored as `null` and read back as "every action",
   * so `PATCH {actions: []}` widened a grant instead of emptying it — the exact
   * opposite of what it reads like, and the opposite of `PermissionsService`,
   * which has always rejected an empty list with 422.
   */
  private assertActionsPresent(actions: string[]): void {
    if (actions.length === 0) {
      throw new UnprocessableEntityException('actions must be non-empty');
    }
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
