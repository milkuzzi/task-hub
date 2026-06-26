import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { StatisticsController } from './statistics.controller';
import { StatisticsExportService } from './statistics-export.service';
import { StatisticsRepository } from './statistics.repository';
import { StatisticsService } from './statistics.service';

/**
 * Модуль Статистики для Администратора (Req 17).
 *
 * Предоставляет {@link StatisticsService} (расчёт показателей по Задачам и
 * Чатам с фильтром по периоду и валидацией диапазона),
 * {@link StatisticsExportService} (экспорт показателей за период в CSV/Excel,
 * Req 17.9, 17.10) и {@link StatisticsRepository} (выборка облегчённых записей
 * задач/сообщений). Опирается на глобальные модули: {@link RepositoriesModule}
 * ({@link UserRepository} — проверка прав Администратора), {@link PrismaModule}
 * ({@link PrismaService}) и {@link ClockModule} ({@link ClockService} —
 * детерминированное «сейчас» для классификации просрочек, Req 17.2, и
 * форматирование периода MSK в экспорте).
 */
@Module({
  imports: [AuthModule],
  controllers: [StatisticsController],
  providers: [StatisticsRepository, StatisticsService, StatisticsExportService],
  exports: [StatisticsService, StatisticsExportService],
})
export class StatisticsModule {}
