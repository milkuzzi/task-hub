import { Injectable } from '@nestjs/common';
import { ClockService } from '../clock';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { UserRepository } from '../repositories';
import { hasAdminPrivileges } from '../users/permissions';
import { computeStatistics } from './statistics.math';
import { StatisticsRepository } from './statistics.repository';
import { DateRange, Statistics } from './statistics.types';

/**
 * Прикладной сервис Статистики для Администратора (Req 17.1–17.8).
 *
 * Отвечает за права доступа (статистику видит только Администратор),
 * валидацию периода (Req 17.7) и выборку данных через {@link StatisticsRepository};
 * сами числовые расчёты — доли, средние, округления, агрегаты — выполняют
 * чистые функции {@link computeStatistics} ({@link ./statistics.math}), что
 * делает их детерминированными и тестируемыми (свойства 46–50).
 *
 * Время «сейчас» для классификации просрочек берётся из {@link ClockService}
 * (Req 17.2), что обеспечивает детерминизм в тестах.
 */
@Injectable()
export class StatisticsService {
  constructor(
    private readonly statisticsRepository: StatisticsRepository,
    private readonly userRepository: UserRepository,
    private readonly clock: ClockService,
  ) {}

  /**
   * Рассчитывает статистику по Задачам и Чатам, опционально ограниченную
   * периодом (Req 17.1–17.8).
   *
   * Доступ имеет только Администратор; прочим инициаторам (в т.ч. Менеджеру и
   * Исполнителю) доступ отклоняется. При заданном периоде с датой начала позже
   * даты окончания запрос отклоняется с ошибкой валидации (Req 17.7); согласно
   * требованию слой отображения сохраняет ранее показанную статистику без
   * изменений (ошибка не меняет состояние). При отсутствии данных за период все
   * показатели нулевые и выставляется признак отсутствия данных (Req 17.8).
   *
   * @param adminId Идентификатор инициатора (должен быть Администратором).
   * @param period Необязательный период выборки (границы включительно, Req 17.6).
   * @returns Готовая к отображению статистика.
   * @throws AccessDeniedException Если инициатор не найден/удалён или не является Администратором.
   * @throws ValidationException Если в периоде дата начала позже даты окончания (Req 17.7).
   */
  async compute(adminId: string, period?: DateRange): Promise<Statistics> {
    const actor = await this.userRepository.findActiveById(adminId);
    if (actor === null || !hasAdminPrivileges(actor.role)) {
      // Статистику просматривает только Администратор (Req 17).
      throw new AccessDeniedException('Просмотр статистики доступен только администратору.');
    }

    const range = period ?? null;
    if (range !== null && range.start.getTime() > range.end.getTime()) {
      // Некорректный диапазон дат: запрос отклоняется без изменения состояния
      // (Req 17.7).
      throw new ValidationException('Дата начала периода не может быть позже даты окончания.');
    }

    const [tasks, messages] = await Promise.all([
      this.statisticsRepository.findTasksForStatistics(range),
      this.statisticsRepository.findMessagesForStatistics(range),
    ]);

    return computeStatistics({ tasks, messages, period: range, now: this.clock.now() });
  }
}
