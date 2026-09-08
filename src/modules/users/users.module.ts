import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { StorageModule } from '@/core/storage/storage.module';

import { EmailChangeChallenge } from './entities/email-change-challenge.entity';
import { ProfileAuditEvent } from './entities/profile-audit-event.entity';
import { User } from './entities/user.entity';
import { UserProfileAuditEvent } from './entities/user-profile-audit-event.entity';
import { EmailChangeService } from './email-change.service';
import { ProfileAuditService } from './profile-audit.service';
import { UsersAuditService } from './users-audit.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfileAuditEvent,
      EmailChangeChallenge,
      ProfileAuditEvent,
    ]),
    StorageModule,
    forwardRef(() => AuthModule),
    forwardRef(() => RbacModule),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UsersAuditService,
    ProfileAuditService,
    EmailChangeService,
  ],
  exports: [UsersService, UsersAuditService, TypeOrmModule],
})
export class UsersModule {}
