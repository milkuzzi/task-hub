import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { MaxOAuthModule } from '../max/oauth';
import { UsersController } from './users.controller';
import { ProfileController } from './profile.controller';
import { AvatarsController } from './avatars.controller';
import { UsersService } from './users.service';
import { AVATAR_STORAGE, FileSystemAvatarStorage } from './avatar-storage';

/**
 * Модуль управления пользователями (Req 2, 3, 4, 6, 7, 8).
 *
 * Предоставляет {@link UsersService}. Опирается на глобальные модули:
 * {@link RepositoriesModule} (инъекция {@link UserRepository}),
 * {@link PrismaModule} (транзакции), {@link MailerModule}
 * ({@link MailerService}) и {@link ClockModule} ({@link ClockService}).
 * Дополнительно импортирует {@link AuthModule} ради
 * {@link AuthService.revokeAllSessions} — аннулирование сессий бывшего
 * администратора при передаче роли ≤5с (Req 3.4). Цикл зависимостей отсутствует:
 * {@link AuthModule} не зависит от {@link UsersModule}. Используется как
 * REST-слоем, так и CLI-командой создания первичного администратора (Req 4).
 *
 * HTTP-слой собственного профиля ({@link ProfileController}) — тонкий REST
 * поверх {@link UsersService}: загрузка аватара (Req 3.1) и привязка профиля MAX
 * (Req 3.2). Для обмена кода авторизации OAuth MAX импортируется
 * {@link MaxOAuthModule} (порт {@link MAX_OAUTH_PORT}); цикла зависимостей не
 * возникает — {@link MaxOAuthModule} зависит только от {@link AppConfigModule}.
 */
@Module({
  imports: [AuthModule, MaxOAuthModule],
  controllers: [UsersController, ProfileController, AvatarsController],
  providers: [UsersService, { provide: AVATAR_STORAGE, useClass: FileSystemAvatarStorage }],
  exports: [UsersService],
})
export class UsersModule {}
