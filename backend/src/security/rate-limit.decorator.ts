import { SetMetadata } from '@nestjs/common';
import { SensitiveOp } from './security.types';

/** Ключ метаданных, хранящий тип чувствительной операции маршрута. */
export const RATE_LIMIT_OP_KEY = 'security:rateLimitOp';

/**
 * Помечает обработчик чувствительной операции типом {@link SensitiveOp}, к
 * которому {@link RateLimitGuard} применяет ограничение частоты запросов
 * (Req 19.1).
 *
 * Применяется к методам контроллеров чувствительных операций:
 * - вход — `AuthController.login` (`'login'`);
 * - запрос восстановления пароля — `AuthController.requestPasswordReset`
 *   (`'password_reset'`);
 * - установка пароля — `AuthController.setPassword` (`'set_password'`);
 * - смена пароля — `UsersController.changePassword` (`'change_password'`);
 * - отправка сообщения — HTTP-обработчик/обвязка Gateway (`'send_message'`);
 * - загрузка вложения — `AttachmentsController.upload` (`'upload'`).
 *
 * @example
 * ```ts
 * @UseGuards(RateLimitGuard)
 * @RateLimit('login')
 * @Post('login')
 * login() { ... }
 * ```
 */
export const RateLimit = (op: SensitiveOp): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_OP_KEY, op);
