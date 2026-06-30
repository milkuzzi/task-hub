import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AttachmentsController } from '../attachments/attachments.controller';
import { AuthController } from '../auth/auth.controller';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RATE_LIMIT_OP_KEY } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { SensitiveOp } from './security.types';

function methodTarget(target: object, method: string): object {
  return (target as Record<string, object>)[method]!;
}

function guardsFor(target: object, method: string): unknown[] {
  return (
    (Reflect.getMetadata(GUARDS_METADATA, methodTarget(target, method)) as unknown[] | undefined) ??
    []
  );
}

function operationFor(target: object, method: string): SensitiveOp | undefined {
  return Reflect.getMetadata(RATE_LIMIT_OP_KEY, methodTarget(target, method)) as
    SensitiveOp | undefined;
}

describe('sensitive HTTP route rate limits', () => {
  it.each([
    ['login', 'login'],
    ['max', 'login'],
    ['requestPasswordReset', 'password_reset'],
    ['setPassword', 'set_password'],
  ] as const)('protects AuthController.%s with %s throttling', (method, operation) => {
    expect(guardsFor(AuthController.prototype, method)).toContain(RateLimitGuard);
    expect(operationFor(AuthController.prototype, method)).toBe(operation);
  });

  it('checks authentication before throttling password changes', () => {
    expect(guardsFor(AuthController.prototype, 'changePassword')).toEqual([
      SessionAuthGuard,
      RateLimitGuard,
    ]);
    expect(operationFor(AuthController.prototype, 'changePassword')).toBe('change_password');
  });

  it('checks authentication before throttling attachment uploads', () => {
    const controllerGuards =
      (Reflect.getMetadata(GUARDS_METADATA, AttachmentsController) as unknown[] | undefined) ?? [];
    expect(controllerGuards).toContain(SessionAuthGuard);
    expect(guardsFor(AttachmentsController.prototype, 'upload')).toEqual([RateLimitGuard]);
    expect(operationFor(AttachmentsController.prototype, 'upload')).toBe('upload');
  });
});
