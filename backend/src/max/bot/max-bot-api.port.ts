import { Injectable, Logger } from '@nestjs/common';

export type MaxBotKeyboardButton =
  { type: 'open_app'; text: string } | { type: 'link'; text: string; url: string };

export type MaxBotKeyboard = MaxBotKeyboardButton[][];

export interface MaxBotApiPort {
  reply(maxUserId: string, text: string, keyboard?: MaxBotKeyboard): Promise<void>;
}

export const MAX_BOT_API_PORT = Symbol('MAX_BOT_API_PORT');

@Injectable()
export class UnavailableMaxBotApiAdapter implements MaxBotApiPort {
  private readonly logger = new Logger(UnavailableMaxBotApiAdapter.name);

  async reply(maxUserId: string, text: string): Promise<void> {
    this.logger.debug(
      `Ответ пользователю MAX «${maxUserId}» пропущен (${text.length} символов): Bot API недоступен.`,
    );
  }
}
