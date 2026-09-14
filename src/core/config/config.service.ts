import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { Config } from './config.types';

type BooleanConfigKey = {
  [K in keyof Config]-?: boolean extends NonNullable<Config[K]> ? K : never;
}[keyof Config];

@Injectable()
export class ConfigService extends NestConfigService {
  get<T extends keyof Config>(key: T): string {
    const value = super.get<Config[T]>(key);
    return String(value);
  }

  /**
   * Read a boolean flag. `get()` stringifies everything it returns, so reading
   * a flag through it yields the truthy string `'false'` and the flag can never
   * turn anything off. Values arrive either already coerced by the Joi schema
   * or as the raw `.env` string, so both are handled.
   */
  getBoolean<T extends BooleanConfigKey>(key: T): boolean {
    const value = super.get<Config[T]>(key);

    if (typeof value === 'boolean') {
      return value;
    }

    return String(value).trim().toLowerCase() === 'true';
  }
}
