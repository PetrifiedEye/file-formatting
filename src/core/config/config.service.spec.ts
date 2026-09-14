import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { ConfigService } from './config.service';

describe('ConfigService', () => {
  let service: ConfigService;
  let raw: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfigService],
    }).compile();

    service = module.get<ConfigService>(ConfigService);
    raw = jest.spyOn(NestConfigService.prototype, 'get');
  });

  afterEach(() => {
    raw.mockRestore();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBoolean', () => {
    it('passes a coerced boolean through unchanged', () => {
      raw.mockReturnValue(false);
      expect(service.getBoolean('HEALTH_CHECK_ENABLED')).toBe(false);

      raw.mockReturnValue(true);
      expect(service.getBoolean('HEALTH_CHECK_ENABLED')).toBe(true);
    });

    it.each(['false', 'FALSE', ' false ', '0', '', 'no', 'undefined'])(
      'reads %p as false (get() would have made it truthy)',
      (value) => {
        raw.mockReturnValue(value);
        expect(service.getBoolean('HEALTH_CHECK_ENABLED')).toBe(false);
        expect(service.get('HEALTH_CHECK_ENABLED')).toBe(value);
      },
    );

    it.each(['true', 'TRUE', ' True '])('reads %p as true', (value) => {
      raw.mockReturnValue(value);
      expect(service.getBoolean('HEALTH_CHECK_ENABLED')).toBe(true);
    });

    it('reads an unset flag as false', () => {
      raw.mockReturnValue(undefined);
      expect(service.getBoolean('HEALTH_CHECK_ENABLED')).toBe(false);
    });
  });
});
