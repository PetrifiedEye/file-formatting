import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';

interface AccessSnapshot {
  permissionNames: Set<string>;
  grantsByRole: Map<string, Map<string, Set<string>>>;
}

const EMPTY_SNAPSHOT: AccessSnapshot = {
  permissionNames: new Set(),
  grantsByRole: new Map(),
};

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

@Injectable()
export class AccessConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessConfigService.name);

  private snapshot: AccessSnapshot = EMPTY_SNAPSHOT;

  /**
   * True while the in-memory snapshot is known not to reflect the database. A
   * failed `reload()` used to leave the previous snapshot in place, so a
   * committed revocation kept being honoured as a grant for as long as the
   * process lived. Authorization now fails closed until a retry succeeds.
   */
  private stale = false;

  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = RETRY_BASE_DELAY_MS;

  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    private readonly rbacAuditService: RbacAuditService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.snapshot = await this.buildSnapshot();
    this.startPeriodicRefresh();
  }

  onModuleDestroy(): void {
    this.cancelRetry();
    this.cancelPeriodicRefresh();
  }

  /**
   * A mutation reloads the snapshot in the process that served it — and only
   * there. Behind a load balancer, a grant revoked on replica A went on being
   * honoured by replica B for the life of that process. Rebuilding on a timer
   * bounds that window to the interval without needing a broker the stack does
   * not have (`specs/002-rbac/research.md` deferred LISTEN/NOTIFY for exactly
   * that reason).
   */
  private startPeriodicRefresh(): void {
    const intervalMs = Number(
      this.configService.get('RBAC_SNAPSHOT_REFRESH_MS'),
    );

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  private cancelPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * The quiet sibling of `reload()`: no audit row, because nothing happened
   * that anyone asked for, and no fail-closed on error. `reload()` denies
   * everything when it fails because the snapshot it holds is known to be
   * wrong — a mutation just committed. Here the snapshot is merely possibly
   * stale, so a transient database blip must not take authorization down.
   */
  private async refresh(): Promise<void> {
    try {
      this.snapshot = await this.buildSnapshot();
      this.stale = false;
    } catch (error) {
      this.logger.warn(
        `Periodic RBAC snapshot refresh failed; keeping the current snapshot: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  hasPermission(
    roleNames: string[],
    permission: string,
    action: string,
  ): boolean {
    if (this.stale) {
      return false;
    }

    if (!this.snapshot.permissionNames.has(permission)) {
      return false;
    }

    for (const roleName of roleNames) {
      const roleGrants = this.snapshot.grantsByRole.get(roleName);
      if (!roleGrants) {
        continue;
      }

      const actions = roleGrants.get(permission);
      if (!actions) {
        continue;
      }

      if (actions.has(action)) {
        return true;
      }
    }

    return false;
  }

  /** Exposed for diagnostics and tests: is authorization currently failing closed? */
  isStale(): boolean {
    return this.stale;
  }

  async reload(): Promise<void> {
    let newSnapshot: AccessSnapshot;

    try {
      newSnapshot = await this.buildSnapshot();
    } catch (error) {
      // The caller's mutation has already committed, so throwing here would
      // report a failure for work that succeeded. Instead, drop the snapshot
      // (deny everything) and keep retrying until the database answers.
      this.snapshot = EMPTY_SNAPSHOT;
      this.stale = true;
      this.logger.error(
        `RBAC snapshot reload failed; denying all permission checks until it succeeds: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      await this.recordReloadFailure(error);
      this.scheduleRetry();
      return;
    }

    this.cancelRetry();
    this.snapshot = newSnapshot;
    this.stale = false;
    this.retryDelayMs = RETRY_BASE_DELAY_MS;

    await this.rbacAuditService.record(
      RbacAuditEventType.CONFIG_RELOADED,
      RbacAuditOutcome.SUCCESS,
      { entityType: RbacAuditEntityType.CONFIG },
    );
  }

  private async recordReloadFailure(error: unknown): Promise<void> {
    try {
      await this.rbacAuditService.record(
        RbacAuditEventType.CONFIG_RELOAD_FAILED,
        RbacAuditOutcome.FAILURE,
        {
          entityType: RbacAuditEntityType.CONFIG,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
      );
    } catch {
      // The audit table lives in the same database that just failed us; losing
      // the row must not prevent the retry from being scheduled.
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }

    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_DELAY_MS);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reload();
    }, delay);

    // A pending retry must not hold the process (or a test runner) open.
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async buildSnapshot(): Promise<AccessSnapshot> {
    const [roles, permissions, grants] = await Promise.all([
      this.roleRepository.find(),
      this.permissionRepository.find(),
      this.grantRepository.find(),
    ]);

    const roleById = new Map(roles.map((role) => [role.id, role]));
    const permissionById = new Map(
      permissions.map((permission) => [permission.id, permission]),
    );

    const permissionNames = new Set(
      permissions.map((permission) => permission.name),
    );
    const grantsByRole = new Map<string, Map<string, Set<string>>>();

    for (const grant of grants) {
      const role = roleById.get(grant.roleId);
      const permission = permissionById.get(grant.permissionId);
      if (!role || !permission) {
        continue;
      }

      let roleGrants = grantsByRole.get(role.name);
      if (!roleGrants) {
        roleGrants = new Map();
        grantsByRole.set(role.name, roleGrants);
      }

      // A grant allows exactly the actions it names. An unset or empty list is
      // *not* a wildcard: treating it as "every action" meant that adding an
      // action to a permission silently handed that action to every grant that
      // had never enumerated one. Anything unnamed is denied.
      const permissionActionSet = new Set(permission.actions);
      const grantActions = new Set(
        (grant.actions ?? []).filter((action) =>
          permissionActionSet.has(action),
        ),
      );

      roleGrants.set(permission.name, grantActions);
    }

    return { permissionNames, grantsByRole };
  }
}
