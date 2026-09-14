import { Test, TestingModule } from '@nestjs/testing';

import { ConfigService } from '@/core/config/config.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: {
    getEmptyResponse: jest.Mock;
    checkHealth: jest.Mock;
  };
  let configService: { getBoolean: jest.Mock };

  beforeEach(async () => {
    healthService = {
      getEmptyResponse: jest
        .fn()
        .mockReturnValue({ status: 'ok', details: {} }),
      checkHealth: jest
        .fn()
        .mockResolvedValue({ status: 'ok', info: {}, details: {} }),
    };
    configService = { getBoolean: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useValue: healthService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('runs the health checks when HEALTH_CHECK_ENABLED is true', async () => {
    configService.getBoolean.mockReturnValue(true);

    const result = await controller.check();

    expect(configService.getBoolean).toHaveBeenCalledWith(
      'HEALTH_CHECK_ENABLED',
    );
    expect(healthService.checkHealth).toHaveBeenCalled();
    expect(healthService.getEmptyResponse).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'ok', info: {}, details: {} });
  });

  it('returns the empty response when HEALTH_CHECK_ENABLED is false', async () => {
    configService.getBoolean.mockReturnValue(false);

    const result = await controller.check();

    expect(healthService.getEmptyResponse).toHaveBeenCalled();
    expect(healthService.checkHealth).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'ok', details: {} });
  });
});
