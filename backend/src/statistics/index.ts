export { StatisticsModule } from './statistics.module';
export { StatisticsController } from './statistics.controller';
export { StatisticsService } from './statistics.service';
export { StatisticsExportService } from './statistics-export.service';
export { StatisticsRepository } from './statistics.repository';
export {
  type StatisticsView,
  type ParticipantStatView,
  type ChatActivityView,
  toStatisticsView,
  participantIdsOf,
} from './statistics-representation';
export { PeriodDto, EXPORT_FORMATS } from './dto';
export {
  ALL_TASK_STATUSES,
  roundToOneDecimal,
  countByStatus,
  isOverdue,
  computeOverdue,
  computeAverageCompletionHours,
  countByParticipant,
  computeChatActivity,
  computeStatistics,
} from './statistics.math';
export {
  type DateRange,
  type StatTaskRecord,
  type StatMessageRecord,
  type ChatActivity,
  type Statistics,
  type StatisticsInput,
} from './statistics.types';
export {
  type ExportFormat,
  type StatisticsFile,
  type ExportRow,
  STATUS_LABELS_RU,
  buildExportRows,
  toCsv,
  toXlsx,
  buildStatisticsFile,
} from './statistics.export';
