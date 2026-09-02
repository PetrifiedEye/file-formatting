import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SystemSettings } from './entities/system-settings.entity';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;
  const repository = {
    findOne: jest.fn(),
    save: jest.fn((settings) => Promise.resolve(settings)),
  };

  const baseSettings: SystemSettings = {
    id: 1,
    registrationConfirmationEnabled: false,
    passwordRecoveryConfirmationEnabled: false,
    signInConfirmationEnabled: false,
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireDigit: false,
    passwordRequireSpecial: false,
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repository.findOne.mockResolvedValue({ ...baseSettings });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: getRepositoryToken(SystemSettings), useValue: repository },
      ],
    }).compile();

    service = module.get(SettingsService);
  });

  it('returns singleton settings', async () => {
    const settings = await service.getSettings();
    expect(settings.id).toBe(1);
  });

  it('updates independent confirmation flags', async () => {
    const updated = await service.updateConfirmationPolicy({
      registrationConfirmationEnabled: true,
      passwordRecoveryConfirmationEnabled: true,
    });

    expect(updated.registrationConfirmationEnabled).toBe(true);
    expect(updated.passwordRecoveryConfirmationEnabled).toBe(true);
    expect(updated.signInConfirmationEnabled).toBe(false);
  });

  it('updates password policy fields', async () => {
    const updated = await service.updateConfirmationPolicy({
      passwordMinLength: 12,
      passwordRequireUppercase: true,
    });

    expect(updated.passwordMinLength).toBe(12);
    expect(updated.passwordRequireUppercase).toBe(true);
  });
});
