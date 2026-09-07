import { Test, TestingModule } from '@nestjs/testing';

import { AdminGuard } from './guards/admin.guard';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

describe('SettingsController', () => {
  let controller: SettingsController;
  const settingsService = {
    getSettings: jest.fn(),
    updateConfirmationPolicy: jest.fn(),
  };

  const adminGuard = { canActivate: jest.fn().mockReturnValue(true) };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [{ provide: SettingsService, useValue: settingsService }],
    })
      .overrideGuard(AdminGuard)
      .useValue(adminGuard)
      .compile();

    controller = module.get(SettingsController);
  });

  it('returns confirmation policy', async () => {
    settingsService.getSettings.mockResolvedValue({
      registrationConfirmationEnabled: false,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
    });

    const result = await controller.getConfirmationPolicy();
    expect(result.registrationConfirmationEnabled).toBe(false);
  });

  it('updates confirmation policy', async () => {
    settingsService.updateConfirmationPolicy.mockResolvedValue({
      registrationConfirmationEnabled: true,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
    });

    const result = await controller.updateConfirmationPolicy({
      registrationConfirmationEnabled: true,
    });

    expect(result.registrationConfirmationEnabled).toBe(true);
  });
});
