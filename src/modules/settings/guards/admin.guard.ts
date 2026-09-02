import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Placeholder admin guard.
 * TODO: Replace with real admin authentication (JWT/session + role check).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
