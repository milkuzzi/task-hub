import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule, AppConfigService } from '../config';
import { MaxOAuthModule } from '../max/oauth';
import { SecurityModule } from '../security';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SocketSessionDisconnector, SESSION_DISCONNECTOR } from './session-disconnector';

/**
 * Модуль аутентификации и регистрации по приглашению (Req 5, 15.1–15.3,
 * 19.3–19.7, 19.10).
 *
 * Предоставляет {@link AuthService} (приглашение, установка пароля, вход с
 * блокировкой), {@link PasswordService} (хеширование bcrypt),
 * {@link PasswordSetupTokenService} (одноразовые токены установки пароля),
 * {@link SessionTokenService} (выпуск/проверка JWT и реестр сессий) и
 * {@link SessionAuthGuard} (проверка валидности сессии при каждом запросе и
 * socket-подключении). Опирается на глобальные модули: {@link RepositoriesModule}
 * ({@link UserRepository}), {@link RedisModule} ({@link RedisService},
 * {@link SessionRegistry}), {@link MailerModule} ({@link MailerService}),
 * {@link ClockModule} ({@link ClockService}) и {@link AppConfigModule}.
 *
 * JWT-подпись настраивается секретом из конфигурации (HS256); access-токены
 * короткоживущие, их валидность дополнительно сверяется по реестру сессий, что
 * обеспечивает аннулирование ≤5с (Req 19.10).
 */
@Module({
  imports: [
    MaxOAuthModule,
    SecurityModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.auth.jwtSecret,
        signOptions: { expiresIn: config.auth.accessTokenTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    PasswordSetupTokenService,
    SessionTokenService,
    SessionAuthGuard,
    // Порт принудительного отключения сокетов. Реализация поверх Socket.IO
    // ({@link SocketSessionDisconnector}) заменяет прежнюю no-op заглушку:
    // ChatGateway (задача 9.1) регистрирует в ней активный сервер Socket.IO и
    // тем самым обеспечивает мгновенный разрыв соединений при аннулировании
    // сессий (Req 3.4, 8.6, 8.7, 19.10). До регистрации сервера реализация
    // ведёт себя как безопасная заглушка. Связывание через `useExisting`
    // гарантирует единый синглтон для AuthService и ChatGateway.
    SocketSessionDisconnector,
    { provide: SESSION_DISCONNECTOR, useExisting: SocketSessionDisconnector },
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionTokenService,
    SessionAuthGuard,
    SocketSessionDisconnector,
    SESSION_DISCONNECTOR,
  ],
})
export class AuthModule {}
