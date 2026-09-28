import { Module, forwardRef } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { StorageModule } from '@/core/storage/storage.module';

import { AccountDeletionAuditService } from '@/modules/users/account-deletion/account-deletion-audit.service';
import { AccountDeletionService } from '@/modules/users/account-deletion/account-deletion.service';
import { AccountDeletionAuditEvent } from './entities/account-deletion-audit-event.entity';
import { AccountDeletionChallenge } from './entities/account-deletion-challenge.entity';
import { EmailChangeChallenge } from './entities/email-change-challenge.entity';
import { ProfileAuditEvent } from './entities/profile-audit-event.entity';
import { User } from './entities/user.entity';
import { UserDirectoryAuditEvent } from './entities/user-directory-audit-event.entity';
import { UserProfileAuditEvent } from './entities/user-profile-audit-event.entity';
import { EmailChangeService } from '@/modules/users/email-change/email-change.service';
import { ProfileAuditService } from '@/modules/users/profile/profile-audit.service';
import { UserDirectoryAuditFilter } from '@/modules/users/directory/user-directory-audit.filter';
import { UserDirectoryAuditService } from '@/modules/users/directory/user-directory-audit.service';
import { UserDirectoryService } from '@/modules/users/directory/user-directory.service';
import { UsersAuditService } from '@/modules/users/profile/users-audit.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfileAuditEvent,
      EmailChangeChallenge,
      ProfileAuditEvent,
      AccountDeletionChallenge,
      AccountDeletionAuditEvent,
      UserDirectoryAuditEvent,
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
    AccountDeletionAuditService,
    AccountDeletionService,
    UserDirectoryAuditService,
    UserDirectoryService,
    { provide: APP_FILTER, useClass: UserDirectoryAuditFilter },
  ],
  exports: [UsersService, UsersAuditService, TypeOrmModule],
})
export class UsersModule {}
