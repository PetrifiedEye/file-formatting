import {
  REQUIRE_PERMISSION_KEY,
  RequirePermission,
} from './require-permission.decorator';

describe('RequirePermission', () => {
  it('records the permission and action for PermissionGuard to read', () => {
    class Controller {
      @RequirePermission('users', 'read')
      list(): void {}
    }

    const handler = Object.getOwnPropertyDescriptor(
      Controller.prototype,
      'list',
    )!.value as object;

    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toEqual({
      permission: 'users',
      action: 'read',
    });
  });

  it('applies to a whole controller too', () => {
    @RequirePermission('settings', 'write')
    class Controller {}

    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, Controller)).toEqual({
      permission: 'settings',
      action: 'write',
    });
  });
});
