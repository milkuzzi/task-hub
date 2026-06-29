import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { ChatModule } from '../chat';
import { SecurityModule } from '../security';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { DocumentPreviewService } from './document-preview.service';
import { PassthroughThumbnailGenerator, THUMBNAIL_GENERATOR } from './thumbnail-generator';

/**
 * Модуль Вложений Чата (Req 11.9, 12, 19.8, 19.9).
 *
 * Предоставляет {@link AttachmentsService} — загрузку файлов любого типа в Чат
 * Задачи с единым лимитом размера 25 МБ, лимитом 10 Вложений на Сообщение,
 * хранением вне веб-корня со сжатием и контролем целостности, а также отказом
 * без сохранения частичного файла при прерывании передачи.
 *
 * Зависимости предоставляются глобальными модулями и не требуют явного импорта:
 * - {@link RepositoriesModule} — {@link AttachmentRepository},
 *   {@link MessageRepository}, {@link TaskRepository}, {@link UserRepository};
 * - {@link StorageModule} — {@link StorageService} (сжатое хранение вне
 *   веб-корня, контрольная сумма);
 * - {@link PrismaModule}, {@link ConfigModule} — {@link PrismaService} и
 *   {@link AppConfigService} (лимиты Req 11.9, 12.2).
 *
 * Генерация миниатюр (Req 12.6) скрыта за портом {@link ThumbnailGenerator},
 * предоставляемым по токену {@link THUMBNAIL_GENERATOR}; по умолчанию
 * используется {@link PassthroughThumbnailGenerator} без нативных зависимостей.
 * Продуктовую реализацию с реальным масштабированием можно подключить заменой
 * провайдера токена без изменения {@link AttachmentsService}.
 *
 * HTTP-слой ({@link AttachmentsController}) — тонкий REST поверх
 * {@link AttachmentsService} и {@link ChatService}: список и загрузка Вложений,
 * контролируемая отдача содержимого и миниатюр (Req 11.10, 12). Для него
 * импортируются {@link AuthModule} ({@link SessionAuthGuard}) и
 * {@link ChatModule} ({@link ChatService}); цикла зависимостей не возникает —
 * {@link ChatModule} не импортирует {@link AttachmentsModule}.
 */
@Module({
  imports: [AuthModule, ChatModule, SecurityModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    DocumentPreviewService,
    { provide: THUMBNAIL_GENERATOR, useClass: PassthroughThumbnailGenerator },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
