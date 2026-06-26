import { Controller, Get, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { UserRepository } from '../repositories';
import { ExportFormat } from './statistics.export';
import { StatisticsExportService } from './statistics-export.service';
import { StatisticsService } from './statistics.service';
import { DateRange } from './statistics.types';
import { PeriodDto } from './dto';
import { StatisticsView, participantIdsOf, toStatisticsView } from './statistics-representation';

/**
 * HTTP-слой Статистики для Администратора (Req 8.1–8.3 спеки; исходное ТЗ Req 17).
 *
 * Тонкий контроллер над {@link StatisticsService} (расчёт показателей) и
 * {@link StatisticsExportService} (экспорт файла). Разбирает период из
 * query-параметров и делегирует доменным сервисам. Доступ только Администратора
 * и валидация диапазона (начало не позже конца, Req 17.7) выполняются в
 * сервисах — контроллер их не дублирует (`compute`/`export` отклоняют
 * не-Администратора и некорректный диапазон, не меняя состояние). Все маршруты
 * требуют действующей Сессии ({@link SessionAuthGuard}). Глобальный префикс
 * `/api` применяется в `main.ts`; доменные исключения преобразуются глобальным
 * фильтром в единый формат `{ code, message }` (Req 1.1) — в т.ч. при экспорте,
 * где клиент читает тело ошибки как Blob/JSON.
 */
@Controller('statistics')
@UseGuards(SessionAuthGuard)
export class StatisticsController {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly statisticsExportService: StatisticsExportService,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Рассчитывает Статистику за необязательный период (Req 8.1; исходное ТЗ
   * Req 17.1–17.8). Делегирует {@link StatisticsService.compute}; доступ только
   * Администратору и проверка диапазона — внутри сервиса (Req 17.7). Имена
   * участников разрешаются для представления контракта фронтенда.
   */
  @Get()
  async compute(
    @Query() query: PeriodDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<StatisticsView> {
    const adminId = this.principal(req).userId;
    const period = this.toDateRange(query);
    const stats = await this.statisticsService.compute(adminId, period);
    const nameOf = await this.buildNameResolver(participantIdsOf(stats));
    return toStatisticsView(stats, nameOf);
  }

  /**
   * Экспортирует Статистику за период в выбранном формате (Req 8.2; исходное ТЗ
   * Req 17.9, 17.10). Делегирует {@link StatisticsExportService.export} и отдаёт
   * файл потоком с заголовками типа и имени (`statistics.csv`/`statistics.xlsx`).
   * Доступ только Администратору и проверка диапазона — внутри сервиса (Req 17.7);
   * при ошибке доменное исключение пробрасывается глобальному фильтру, заголовки
   * файла при этом не выставляются.
   */
  @Get('export')
  async export(
    @Query() query: PeriodDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const adminId = this.principal(req).userId;
    const period = this.requireDateRange(query);
    const format = this.resolveFormat(query.format);
    const file = await this.statisticsExportService.export(adminId, period, format);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.content, { type: file.mimeType });
  }

  /**
   * Строит необязательный доменный период из DTO (Req 17.6).
   *
   * Период считается заданным, только если присутствуют обе границы; одиночная
   * граница недопустима. Пустые/отсутствующие границы означают «весь период»
   * (`undefined`). Валидность диапазона (начало ≤ конец) проверяет сервис
   * (Req 17.7).
   */
  private toDateRange(dto: PeriodDto): DateRange | undefined {
    const hasFrom = dto.from !== undefined && dto.from !== '';
    const hasTo = dto.to !== undefined && dto.to !== '';
    if (!hasFrom && !hasTo) {
      return undefined;
    }
    if (!hasFrom || !hasTo) {
      throw new ValidationException('Период должен задаваться обеими границами: «from» и «to».');
    }
    return { start: new Date(dto.from as string), end: new Date(dto.to as string) };
  }

  /**
   * Возвращает обязательный период для экспорта (Req 17.9): экспорт всегда
   * выполняется за конкретный период, поэтому обе границы обязательны.
   */
  private requireDateRange(dto: PeriodDto): DateRange {
    const range = this.toDateRange(dto);
    if (range === undefined) {
      throw new ValidationException('Экспорт статистики требует указания периода: «from» и «to».');
    }
    return range;
  }

  /** Нормализует формат экспорта, по умолчанию — CSV (Req 17.9). */
  private resolveFormat(format: ExportFormat | undefined): ExportFormat {
    return format ?? 'csv';
  }

  /**
   * Готовит функцию разрешения отображаемого имени участника по идентификатору.
   *
   * Имена подгружаются одним проходом по уникальным идентификаторам разрезов
   * (включая удалённых Пользователей, чтобы статистика по историческим участникам
   * оставалась читаемой); отсутствующие имена заменяются идентификатором в
   * самом представлении.
   */
  private async buildNameResolver(ids: string[]): Promise<(userId: string) => string | undefined> {
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        const user = await this.userRepository.findById(id);
        if (user !== null) {
          names.set(id, user.displayName);
        }
      }),
    );
    return (userId: string) => names.get(userId);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
