import { Injectable } from '@nestjs/common';
import { ClockService } from '../clock';
import { AppException, ErrorCode } from '../common/errors';
import { buildStatisticsFile, ExportFormat, StatisticsFile } from './statistics.export';
import { StatisticsService } from './statistics.service';
import { DateRange } from './statistics.types';

/**
 * Прикладной сервис экспорта статистики в CSV/Excel (Req 17.9, 17.10).
 *
 * Вынесен отдельно от {@link StatisticsService} (расчёт показателей), чтобы
 * сосредоточить здесь только формирование файла. Доступ и валидация периода
 * переиспользуются: данные берутся через {@link StatisticsService.compute}, что
 * гарантирует те же правила (экспорт доступен только Администратору; период с
 * датой начала позже окончания отклоняется, Req 17.7) и то, что файл содержит
 * ровно отображаемые показатели за выбранный период (Req 17.9).
 *
 * Сериализация выполняется чистыми функциями {@link buildStatisticsFile}
 * ({@link ./statistics.export}); при ошибке формирования файла экспорт
 * прерывается ошибкой, а расчёт/состояние отображаемой статистики не меняются
 * (Req 17.10).
 */
@Injectable()
export class StatisticsExportService {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Формирует файл экспорта статистики за период в выбранном формате (Req 17.9,
   * 17.10).
   *
   * Сначала рассчитывает статистику через {@link StatisticsService.compute}
   * (проверка прав Администратора и валидность диапазона; соответствующие ошибки
   * пробрасываются без изменений), затем сериализует её в CSV или XLSX. Если при
   * формировании файла возникает ошибка, экспорт прерывается ошибкой
   * формирования (Req 17.10), при этом расчёт статистики уже завершён и его
   * результат не изменяется.
   *
   * @param adminId Идентификатор инициатора (должен быть Администратором).
   * @param period Период выборки (границы включительно, Req 17.6).
   * @param format Выбранный формат экспорта (`csv` или `xlsx`, Req 17.9).
   * @returns Готовый к скачиванию файл (имя, MIME-тип, содержимое).
   * @throws AccessDeniedException Если инициатор не Администратор.
   * @throws ValidationException Если диапазон периода некорректен (Req 17.7).
   * @throws AppException С кодом внутренней ошибки при сбое формирования файла (Req 17.10).
   */
  async export(adminId: string, period: DateRange, format: ExportFormat): Promise<StatisticsFile> {
    // Доступ и валидация диапазона выполняются здесь; их ошибки пробрасываются
    // как есть и не относятся к ошибкам формирования файла (Req 17.7, 17.10).
    const stats = await this.statisticsService.compute(adminId, period);

    try {
      return buildStatisticsFile(stats, format, (date) => this.clock.formatMsk(date));
    } catch {
      // Сбой формирования файла: экспорт прерывается, рассчитанная статистика
      // остаётся без изменений (Req 17.10).
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Не удалось сформировать файл экспорта статистики.',
      );
    }
  }
}
