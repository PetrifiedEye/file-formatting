import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { LessThan, Repository } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { LocalFileStorageService } from '@/core/storage/local-file-storage.service';

import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { UserProfileAuditOutcome } from './entities/user-profile-audit-event.entity';
import { User, UserStatus } from './entities/user.entity';
import { UsersAuditService } from './users-audit.service';
import { detectImageExtension } from './utils/image-type';
import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
} from '@/modules/auth/utils/lockout.constants';
import { AccessConfigService } from '@/modules/rbac/access-config.service';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  status: UserStatus;
  pendingExpiresAt?: Date | null;
  confirmedAt?: Date | null;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly accessConfigService: AccessConfigService,
    private readonly usersAuditService: UsersAuditService,
    private readonly storageService: LocalFileStorageService,
    private readonly configService: ConfigService,
  ) {}

  async updatePhoto(targetId: string, fileBuffer: Buffer): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: targetId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const ext = detectImageExtension(fileBuffer);
    if (!ext) {
      throw new BadRequestException('Unsupported or invalid image file');
    }

    const relativePath = await this.storageService.save(fileBuffer, ext);
    const previousRelativePath = this.toRelativeAssetPath(user.photoUrl);

    user.photoUrl = `${this.configService.get('ASSETS_BASE_URL')}/assets/${relativePath}`;
    await this.usersRepository.save(user);

    if (previousRelativePath) {
      await this.storageService.delete(previousRelativePath);
    }

    return user;
  }

  async updateEmailDirect(targetId: string, newEmail: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: targetId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const existing = await this.usersRepository.findOne({
      where: { email: newEmail },
    });
    if (existing && existing.id !== user.id) {
      throw new ConflictException('Email already in use');
    }

    user.email = newEmail;
    return this.usersRepository.save(user);
  }

  toRelativeAssetPath(photoUrl: string | null): string | null {
    if (!photoUrl) {
      return null;
    }

    const prefix = `${this.configService.get('ASSETS_BASE_URL')}/assets/`;
    return photoUrl.startsWith(prefix) ? photoUrl.slice(prefix.length) : null;
  }

  async getProfileFor(
    viewer: RequestUser,
    targetId: string,
  ): Promise<UserProfileResponseDto> {
    if (targetId === viewer.id) {
      const user = await this.usersRepository.findOne({
        where: { id: viewer.id },
      });

      if (!user) {
        await this.recordAudit(
          viewer.id,
          targetId,
          UserProfileAuditOutcome.NOT_FOUND,
        );
        throw new NotFoundException('User not found');
      }

      await this.recordAudit(
        viewer.id,
        targetId,
        UserProfileAuditOutcome.SELF_VIEW,
      );

      return {
        id: user.id,
        photo: user.photoUrl,
        email: user.email,
        status: user.status,
        createdAt: user.createdAt,
      };
    }

    const hasAccess = this.accessConfigService.hasPermission(
      viewer.roles,
      'users',
      'read',
    );

    if (!hasAccess) {
      await this.recordAudit(
        viewer.id,
        targetId,
        UserProfileAuditOutcome.DENIED,
      );
      throw new ForbiddenException('Insufficient permissions');
    }

    const target = isUUID(targetId)
      ? await this.usersRepository.findOne({ where: { id: targetId } })
      : null;

    if (!target) {
      await this.recordAudit(
        viewer.id,
        targetId,
        UserProfileAuditOutcome.NOT_FOUND,
      );
      throw new NotFoundException('User not found');
    }

    await this.recordAudit(
      viewer.id,
      targetId,
      UserProfileAuditOutcome.PRIVILEGED_VIEW,
    );

    return { id: target.id, photo: target.photoUrl };
  }

  private async recordAudit(
    viewerId: string,
    targetId: string,
    outcome: UserProfileAuditOutcome,
  ): Promise<void> {
    try {
      await this.usersAuditService.record(viewerId, targetId, outcome);
    } catch {
      // Audit failures are best-effort (FR-010) and must never affect the response.
    }
  }

  async findByNormalizedEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async create(input: CreateUserInput): Promise<User> {
    const user = this.usersRepository.create({
      email: input.email,
      passwordHash: input.passwordHash,
      status: input.status,
      pendingExpiresAt: input.pendingExpiresAt ?? null,
      confirmedAt: input.confirmedAt ?? null,
    });

    return this.usersRepository.save(user);
  }

  async activate(user: User): Promise<User> {
    user.status = UserStatus.ACTIVE;
    user.confirmedAt = new Date();
    user.pendingExpiresAt = null;
    return this.usersRepository.save(user);
  }

  async updatePendingExpiry(user: User, expiresAt: Date): Promise<User> {
    user.pendingExpiresAt = expiresAt;
    return this.usersRepository.save(user);
  }

  async deleteExpiredPendingUsers(now = new Date()): Promise<void> {
    await this.usersRepository.delete({
      status: UserStatus.PENDING_CONFIRMATION,
      pendingExpiresAt: LessThan(now),
    });
  }

  async deleteUser(user: User): Promise<void> {
    await this.usersRepository.remove(user);
  }

  isLockedOut(user: User, now = new Date()): boolean {
    return !!user.lockedUntil && user.lockedUntil.getTime() > now.getTime();
  }

  async recordFailedLogin(user: User, now = new Date()): Promise<User> {
    user.failedLoginAttempts += 1;

    if (user.failedLoginAttempts >= LOCKOUT_THRESHOLD) {
      user.lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    }

    return this.usersRepository.save(user);
  }

  async recordSuccessfulLogin(user: User): Promise<User> {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    return this.usersRepository.save(user);
  }

  async updatePassword(user: User, passwordHash: string): Promise<User> {
    user.passwordHash = passwordHash;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    return this.usersRepository.save(user);
  }
}
