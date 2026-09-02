import { Test, TestingModule } from '@nestjs/testing';

import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

describe('SettingsController', () => {
  let controller: SettingsController;
  const settingsService = {
    getSettings: jest.fn(),
    updateConfirmationPolicy: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [{ provide: SettingsService, useValue: settingsService }],
    }).compile();

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
