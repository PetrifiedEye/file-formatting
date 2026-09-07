import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { User } from './entities/user.entity';
import { UserProfileAuditEvent } from './entities/user-profile-audit-event.entity';
import { UsersAuditService } from './users-audit.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserProfileAuditEvent]),
    forwardRef(() => AuthModule),
    forwardRef(() => RbacModule),
  ],
  controllers: [UsersController],
  providers: [UsersService, UsersAuditService],
  exports: [UsersService, UsersAuditService, TypeOrmModule],
})
export class UsersModule {}
