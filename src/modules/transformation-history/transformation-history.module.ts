import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '@/core/config/config.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { User } from '@/modules/users/entities/user.entity';
import { UsersModule } from '@/modules/users/users.module';

import { TransformationHistoryAuditEvent } from './entities/transformation-history-audit-event.entity';
import { TransformationHistoryAuditService } from './transformation-history-audit.service';
import { TransformationHistoryController } from './transformation-history.controller';
import { TransformationHistoryService } from './transformation-history.service';

/**
 * Transformation history: a read/reporting concern over data two other modules
 * own.
 *
 * Its own module rather than a route on either conversion module — it spans
 * both families, and it has an authorization model (self, or admin oversight)
 * and an audit trail that belong to neither pipeline. The edge to
 * `ConversionModule` is the `ConversionRecord` entity only, registered here for
 * read access the same way `ImageConversionModule` re-registers it for its own
 * context. No conversion service is reached into.
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    // `AccessConfigService`, for the admin route's permission check.
    RbacModule,
    // `UsersService.findById`, for the admin route's existence check. An
    // explicit module edge rather than a query against the users table from
    // here — whether an account exists is theirs to answer.
    UsersModule,
    TypeOrmModule.forFeature([
      ConversionRecord,
      TransformationHistoryAuditEvent,
      // Read-only, and only so `JwtAuthGuard` can be constructed here: Nest
      // instantiates a guard in the module that applies it, so the guard's own
      // repositories must resolve in this context.
      User,
      UserRole,
    ]),
  ],
  controllers: [TransformationHistoryController],
  providers: [TransformationHistoryService, TransformationHistoryAuditService],
})
export class TransformationHistoryModule {}
