import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from '@/core/email/email.module';
import { UsersModule } from '@/modules/users/users.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import { RegistrationAuditEvent } from './entities/registration-audit-event.entity';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { LoginAuditEvent } from './entities/login-audit-event.entity';
import { ConfirmationChallengeService } from './confirmation-challenge.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import { RegistrationAuditService } from './registration-audit.service';
import { LoginAuditService } from './login-audit.service';
import { SessionService } from './session.service';
import { LoginChallengeService } from './login-challenge.service';
import { PasswordResetService } from './password-reset.service';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConfirmationChallenge,
      RegistrationAuditEvent,
      Session,
      LoginChallenge,
      PasswordResetChallenge,
      LoginAuditEvent,
      UserRole,
    ]),
    UsersModule,
    forwardRef(() => SettingsModule),
    EmailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    ConfirmationChallengeService,
    ConfirmationMailService,
    RegistrationAuditService,
    LoginAuditService,
    SessionService,
    LoginChallengeService,
    PasswordResetService,
    SessionAuthGuard,
  ],
  exports: [SessionAuthGuard, SessionService],
})
export class AuthModule {}
