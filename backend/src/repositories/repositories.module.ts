import { Global, Module } from '@nestjs/common';
import { UserRepository } from './user.repository';
import { TaskRepository } from './task.repository';
import { MessageRepository } from './message.repository';
import { MessageReadRepository } from './message-read.repository';
import { AttachmentRepository } from './attachment.repository';
import { ChatMuteRepository } from './chat-mute.repository';

/**
 * Глобальный модуль репозиториев-обёрток над Prisma.
 *
 * Предоставляет тонкие репозитории доменных сущностей (User, Task, Message)
 * с транзакционными хелперами всему приложению без повторного импорта.
 * Опирается на глобальный {@link PrismaModule} (через инъекцию
 * {@link PrismaService}). Прикладные модули (Auth, Users, Tasks, Chat и др.)
 * используют эти репозитории как общую точку доступа к данным.
 */
@Global()
@Module({
  providers: [
    UserRepository,
    TaskRepository,
    MessageRepository,
    MessageReadRepository,
    AttachmentRepository,
    ChatMuteRepository,
  ],
  exports: [
    UserRepository,
    TaskRepository,
    MessageRepository,
    MessageReadRepository,
    AttachmentRepository,
    ChatMuteRepository,
  ],
})
export class RepositoriesModule {}
