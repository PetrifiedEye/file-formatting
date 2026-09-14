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

  it('passes the body and the calling actor through to the service', async () => {
    settingsService.updateConfirmationPolicy.mockResolvedValue({
      registrationConfirmationEnabled: true,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireDigit: false,
      passwordRequireSpecial: false,
    });

    const result = await controller.updateConfirmationPolicy(
      { registrationConfirmationEnabled: true },
      {
        user: { id: 'admin-1' },
        ip: '10.0.0.9',
        headers: { 'user-agent': 'jest' },
      },
    );

    expect(result.registrationConfirmationEnabled).toBe(true);
    // Without the actor the audit trail cannot say who changed the policy.
    expect(settingsService.updateConfirmationPolicy).toHaveBeenCalledWith(
      { registrationConfirmationEnabled: true },
      { actorUserId: 'admin-1', ipAddress: '10.0.0.9', userAgent: 'jest' },
    );
  });

  it('is guarded by AdminGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      SettingsController,
    ) as unknown[];

    expect(guards).toEqual(expect.arrayContaining([AdminGuard]));
  });
});
