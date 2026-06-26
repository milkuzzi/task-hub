import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * DTO команд Бота MAX на границе webhook-контроллера (Req 16.4–16.12).
 *
 * Каждая команда несёт идентификатор профиля MAX отправителя (`maxUserId`),
 * полученный платформой MAX, и параметры конкретного действия. Идентификация
 * Пользователя Системы по `maxUserId` и проверка прав выполняются прикладным
 * слоем ({@link import('./max-bot.service').MaxBotService}).
 */

/** Базовые поля любой команды Бота MAX: идентификатор профиля MAX. */
export class MaxBotActorDto {
  /** Стабильный идентификатор профиля MAX отправителя команды. */
  @IsString({ message: 'Идентификатор профиля MAX обязателен.' })
  @MinLength(1, { message: 'Идентификатор профиля MAX обязателен.' })
  maxUserId!: string;
}

/** Метаданные прикрепляемого через Бот MAX файла (Req 16.10, 16.11). */
export class MaxBotAttachmentMetaDto {
  /** Исходное имя файла. */
  @IsString({ message: 'Имя файла обязательно.' })
  @MinLength(1, { message: 'Имя файла обязательно.' })
  originalName!: string;

  /** MIME-тип файла (любой тип допускается, Req 12.5). */
  @IsString({ message: 'Тип файла обязателен.' })
  @MinLength(1, { message: 'Тип файла обязателен.' })
  mimeType!: string;

  /** Заявленный размер файла в байтах (для контроля единого лимита, Req 16.11). */
  @IsOptional()
  @Type(() => Number)
  declaredSize?: number;

  /** Токен/идентификатор для загрузки содержимого файла через Bot API MAX. */
  @IsString({ message: 'Токен загрузки файла обязателен.' })
  @MinLength(1, { message: 'Токен загрузки файла обязателен.' })
  downloadToken!: string;
}

/** Команда отправки Сообщения в Чат Задачи через Бот MAX (Req 16.8, 16.10, 16.11). */
export class MaxBotSendMessageDto extends MaxBotActorDto {
  /** Идентификатор Задачи, в Чат которой отправляется Сообщение. */
  @IsString({ message: 'Идентификатор задачи обязателен.' })
  @MinLength(1, { message: 'Идентификатор задачи обязателен.' })
  taskId!: string;

  /** Текст Сообщения (1–4000 символов, Req 11.3, 11.4). */
  @IsString({ message: 'Текст сообщения обязателен.' })
  @MinLength(1, { message: 'Текст сообщения обязателен.' })
  @MaxLength(4000, { message: 'Длина текста сообщения не может превышать 4000 символов.' })
  text!: string;

  /** Метаданные прикрепляемых файлов (содержимое передаётся платформой MAX). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaxBotAttachmentMetaDto)
  attachments?: MaxBotAttachmentMetaDto[];
}

/** Команда заглушения/снятия заглушения Чата Задачи через Бот MAX (Req 16.9). */
export class MaxBotSetMuteDto extends MaxBotActorDto {
  /** Идентификатор Задачи. */
  @IsString({ message: 'Идентификатор задачи обязателен.' })
  @MinLength(1, { message: 'Идентификатор задачи обязателен.' })
  taskId!: string;

  /** Желаемое состояние: `true` — заглушить, `false` — снять. */
  @IsBoolean({ message: 'Состояние заглушения должно быть логическим значением.' })
  muted!: boolean;
}

/** Команда отписки от Уведомлений конкретной Задачи через Бот MAX (Req 16.6). */
export class MaxBotUnsubscribeTaskDto extends MaxBotActorDto {
  /** Идентификатор Задачи. */
  @IsString({ message: 'Идентификатор задачи обязателен.' })
  @MinLength(1, { message: 'Идентификатор задачи обязателен.' })
  taskId!: string;
}

/** Команда отметки Сообщения просмотренным в Боте MAX (Req 16.12). */
export class MaxBotMessageSeenDto extends MaxBotActorDto {
  /** Идентификатор просмотренного Сообщения. */
  @IsString({ message: 'Идентификатор сообщения обязателен.' })
  @MinLength(1, { message: 'Идентификатор сообщения обязателен.' })
  messageId!: string;
}
