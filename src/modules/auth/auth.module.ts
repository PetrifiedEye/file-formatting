import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from '@/core/email/email.module';
import { UsersModule } from '@/modules/users/users.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import { RegistrationAuditEvent } from './entities/registration-audit-event.entity';
import { ConfirmationChallengeService } from './confirmation-challenge.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import { RegistrationAuditService } from './registration-audit.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConfirmationChallenge, RegistrationAuditEvent]),
    UsersModule,
    SettingsModule,
    EmailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    ConfirmationChallengeService,
    ConfirmationMailService,
    RegistrationAuditService,
  ],
})
export class AuthModule {}
