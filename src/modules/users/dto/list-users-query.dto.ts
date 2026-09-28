import { ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { UserStatus } from '../entities/user.entity';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { pageLimitField } from '@/core/validation/joi-fields';

export enum UserDirectorySortField {
  CREATED_AT = 'createdAt',
  LAST_LOGIN_AT = 'lastLoginAt',
  EMAIL = 'email',
}

export enum UserDirectorySortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

const listUsersQueryDtoSchema = Joi.object<ListUsersQueryDto>({
  limit: pageLimitField(),
  cursor: Joi.string().allow(''),
  // Surrounding whitespace is ignored, and a blank search is no search.
  search: Joi.string().trim().empty(''),
  status: Joi.string().valid(...Object.values(UserStatus)),
  sort: Joi.string().valid(...Object.values(UserDirectorySortField)),
  direction: Joi.string().valid(...Object.values(UserDirectorySortDirection)),
});

@JoiSchema(listUsersQueryDtoSchema)
export class ListUsersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  limit?: number;

  @ApiPropertyOptional()
  cursor?: string;

  @ApiPropertyOptional()
  search?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;

  @ApiPropertyOptional({ enum: UserDirectorySortField })
  sort?: UserDirectorySortField;

  @ApiPropertyOptional({ enum: UserDirectorySortDirection })
  direction?: UserDirectorySortDirection;
}
