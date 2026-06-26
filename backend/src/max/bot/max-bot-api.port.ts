import { Injectable, Logger } from '@nestjs/common';
import { UploadFile } from '../../attachments';

/**
 * Ссылка на прикреплённый через Бот MAX файл, полученная во входящем обновлении
 * (Req 16.10, 16.11).
 *
 * Содержимое файла на стороне MAX доступно по `downloadToken`; прикладной слой
 * загружает его через {@link MaxBotApiPort.downloadAttachment} перед сохранением
 * Вложения с применением единого лимита размера (Req 12).
 */
export interface MaxBotAttachmentRef {
  /** Исходное имя файла. */
  originalName: string;
  /** MIME-тип файла (любой тип допускается, Req 12.5). */
  mimeType: string;
  /** Заявленный размер файла в байтах, если известен (Req 16.11). */
  declaredSize?: number;
  /** Токен/идентификатор для загрузки содержимого файла через Bot API MAX. */
  downloadToken: string;
}

/** Краткое представление Задачи для отправки списка в Бот MAX (Req 16.7). */
export interface MaxBotTaskListItem {
  id: string;
  title: string;
  status: string;
}

/**
 * Порт исходящего взаимодействия с Bot API платформы MAX (Req 16.7, 16.8,
 * 16.10).
 *
 * Абстрагирует фактические сетевые вызовы к Bot API MAX (отправку ответов
 * Пользователю и загрузку содержимого прикреплённых файлов) от прикладной
 * логики webhook-контроллера. Благодаря этому маршрутизация команд Бота
 * тестируется без обращения к реальному сервису MAX.
 *
 * До подключения реальной интеграции к токену {@link MAX_BOT_API_PORT}
 * привязан безопасный адаптер {@link UnavailableMaxBotApiAdapter}.
 */
export interface MaxBotApiPort {
  /**
   * Загружает содержимое прикреплённого через Бот MAX файла по ссылке и
   * возвращает его в виде {@link UploadFile} для сохранения Вложения (Req 16.10).
   */
  downloadAttachment(ref: MaxBotAttachmentRef): Promise<UploadFile>;

  /** Отправляет Пользователю список его Задач через Бот MAX (Req 16.7). */
  sendTaskList(maxUserId: string, tasks: MaxBotTaskListItem[]): Promise<void>;

  /** Отправляет Пользователю текстовый ответ через Бот MAX. */
  reply(maxUserId: string, text: string): Promise<void>;
}

/**
 * DI-токен порта {@link MaxBotApiPort}.
 *
 * По умолчанию связан с {@link UnavailableMaxBotApiAdapter}. Реальная
 * интеграция с Bot API MAX переопределяет привязку, не затрагивая
 * webhook-контроллер и {@link import('./max-bot.service').MaxBotService}.
 */
export const MAX_BOT_API_PORT = Symbol('MAX_BOT_API_PORT');

/**
 * Безопасная реализация-заглушка {@link MaxBotApiPort} до подключения реальной
 * интеграции с Bot API MAX.
 *
 * Исходящие операции (`sendTaskList`, `reply`) логируются и завершаются без
 * ошибки — недоступность ответа Бота не влияет на уже выполненное действие в
 * Системе. Загрузка содержимого файла недоступна и явно отклоняется, поэтому
 * отправка Сообщения с Вложением, требующая реальной загрузки, корректно
 * завершается ошибкой до сохранения (Req 16.11), не оставляя частичных данных.
 */
@Injectable()
export class UnavailableMaxBotApiAdapter implements MaxBotApiPort {
  private readonly logger = new Logger(UnavailableMaxBotApiAdapter.name);

  private static readonly REASON = 'Интеграция с Bot API MAX ещё не подключена.';

  async downloadAttachment(ref: MaxBotAttachmentRef): Promise<UploadFile> {
    throw new Error(
      `Загрузка вложения «${ref.originalName}» из Бота MAX недоступна: ` +
        UnavailableMaxBotApiAdapter.REASON,
    );
  }

  async sendTaskList(maxUserId: string, tasks: MaxBotTaskListItem[]): Promise<void> {
    this.logger.debug(
      `Отправка списка из ${tasks.length} задач(и) пользователю MAX «${maxUserId}» пропущена: ` +
        UnavailableMaxBotApiAdapter.REASON,
    );
  }

  async reply(maxUserId: string, text: string): Promise<void> {
    this.logger.debug(
      `Ответ пользователю MAX «${maxUserId}» пропущен (${text.length} символов): ` +
        UnavailableMaxBotApiAdapter.REASON,
    );
  }
}
