import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { User, UserStatus } from './entities/user.entity';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
} from '@/modules/auth/utils/lockout.constants';

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
  ) {}

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
