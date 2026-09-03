import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'rbac:require-permission';

export interface RequiredPermission {
  permission: string;
  action: string;
}

export const RequirePermission = (permission: string, action: string) =>
  SetMetadata<string, RequiredPermission>(REQUIRE_PERMISSION_KEY, {
    permission,
    action,
  });
