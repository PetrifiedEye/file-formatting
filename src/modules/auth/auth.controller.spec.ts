import { Test, TestingModule } from '@nestjs/testing';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    register: jest.fn(),
    confirmByCode: jest.fn(),
    confirmByLink: jest.fn(),
    resendConfirmation: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get(AuthController);
  });

  it('delegates register to AuthService', async () => {
    authService.register.mockResolvedValue({
      message: 'ok',
      confirmationRequired: false,
    });

    const req = { ip: '127.0.0.1', headers: {} } as never;
    const result = await controller.register(
      { email: 'a@b.com', password: 'validpass1' },
      req,
    );

    expect(result.confirmationRequired).toBe(false);
    expect(authService.register).toHaveBeenCalled();
  });
});
