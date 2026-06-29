import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AssignmentKind, Role } from '@prisma/client';
import { AccessDeniedException } from '../common/errors';
import { Page } from '../common/dto';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ClockService } from '../clock';
import { TaskWithAssignments, UserRepository } from '../repositories';
import { SearchQuery, SearchService, TaskFilters } from '../search';
import { Status, StatusAction } from '../status';
import { TaskRealtimeDispatcher, TaskRealtimeReason } from './task-realtime.dispatcher';
import { TasksService } from './tasks.service';
import {
  AssignmentDto,
  ChangeStatusDto,
  CreateTaskDto,
  StatusActionDto,
  TaskQueryDto,
  UpdateTaskDto,
} from './dto';
import { TaskCardView, TaskDetailView, toTaskCard, toTaskDetail } from './task-representation';

/**
 * HTTP-слой управления Задачами (Req 4.1–4.7).
 *
 * Тонкий контроллер над {@link TasksService} и {@link SearchService}: разбирает
 * HTTP-запрос, вызывает доменный метод и формирует представление контракта
 * `frontend/src/lib/tasks-api.ts` / `status-api.ts`. Все маршруты требуют
 * действующей Сессии ({@link SessionAuthGuard}). Видимость, права и доменные
 * инварианты проверяются в сервисах; контроллер не дублирует бизнес-логику.
 * Глобальный префикс `/api` применяется в `main.ts`. Доменные исключения
 * преобразуются глобальным фильтром в единый формат `{ code, message }` (Req 1.1).
 */
@Controller('tasks')
@UseGuards(SessionAuthGuard)
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly searchService: SearchService,
    private readonly clock: ClockService,
    private readonly userRepository: UserRepository,
    private readonly taskRealtime: TaskRealtimeDispatcher,
  ) {}

  /**
   * Список видимых текущему Пользователю Задач с поиском, фильтрами и
   * пагинацией (Req 4.1, 18). Делегирует {@link SearchService.search}; видимость
   * по роли и назначениям определяется сервисом.
   */
  @Get()
  async list(
    @Query() query: TaskQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Page<TaskCardView>> {
    const userId = this.principal(req).userId;
    const page = await this.searchService.search(userId, this.toSearchQuery(query));
    const items = await Promise.all(page.items.map((task) => this.toCard(userId, task)));
    return { items, meta: page.meta };
  }

  /**
   * Детальная Задача (Req 4.2). Делегирует {@link TasksService.getVisibleTask};
   * доступ к чужой Задаче отклоняется без раскрытия содержимого (Req 2.12).
   */
  @Get(':id')
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<TaskDetailView> {
    const userId = this.principal(req).userId;
    const task = await this.tasksService.getVisibleTask(userId, id);
    return this.toDetail(userId, task);
  }

  /**
   * Создание Задачи Менеджером/Администратором (Req 4.3, 9). Делегирует
   * {@link TasksService.create}; возвращает детальное представление созданной
   * Задачи.
   */
  @Post()
  async create(
    @Body() dto: CreateTaskDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskDetailView> {
    const userId = this.principal(req).userId;
    const created = await this.tasksService.create(userId, dto);
    const task = await this.tasksService.getVisibleTask(userId, created.id);
    void this.emitTaskUpdated(task, 'created', [userId]);
    return this.toDetail(userId, task);
  }

  /**
   * Изменение параметров Задачи без смены Статуса (Req 4.4, 10.12). Делегирует
   * {@link TasksService.update}.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskDetailView> {
    const userId = this.principal(req).userId;
    await this.tasksService.update(userId, id, dto);
    const task = await this.tasksService.getVisibleTask(userId, id);
    void this.emitTaskUpdated(task, 'updated', [userId]);
    return this.toDetail(userId, task);
  }

  /**
   * Изменение состава участников Задачи (Req 4.5, 2.4–2.7). Делегирует
   * {@link TasksService.assign}.
   */
  @Post(':id/assign')
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskDetailView> {
    const userId = this.principal(req).userId;
    const previous = await this.tasksService.getVisibleTask(userId, id);
    const task = await this.tasksService.assign(userId, id, dto);
    void this.emitTaskUpdated(task, 'assigned', [userId, ...this.participantIds(previous)]);
    return this.toDetail(userId, task);
  }

  /**
   * Ручная смена Статуса Задачи (Req 4.6, 10.4–10.10). Делегирует
   * {@link TasksService.changeStatus}; недопустимый/неавторизованный переход
   * отклоняется сервисом.
   */
  @Post(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskDetailView> {
    const userId = this.principal(req).userId;
    const task = await this.tasksService.changeStatus(userId, id, this.toStatusAction(dto.action));
    void this.emitTaskUpdated(task, 'status', [userId]);
    return this.toDetail(userId, task);
  }

  /**
   * Преобразует DTO запроса списка в доменный {@link SearchQuery}.
   *
   * Поля строятся условно (учёт `exactOptionalPropertyTypes`): отсутствующие
   * параметры не добавляются, пустые множества фильтров опускаются, чтобы не
   * сужать выборку без необходимости (Req 18.3).
   */
  private toSearchQuery(dto: TaskQueryDto): SearchQuery {
    const filters: TaskFilters = {};
    if (dto.statuses !== undefined && dto.statuses.length > 0) {
      filters.statuses = dto.statuses;
    }
    if (dto.deadlineFrom !== undefined) {
      filters.deadlineFrom = dto.deadlineFrom;
    }
    if (dto.deadlineTo !== undefined) {
      filters.deadlineTo = dto.deadlineTo;
    }
    if (dto.participantIds !== undefined && dto.participantIds.length > 0) {
      filters.participantIds = dto.participantIds;
    }
    if (dto.assignmentKind !== undefined) {
      filters.assignmentKind = dto.assignmentKind;
    }

    const query: SearchQuery = {};
    if (dto.text !== undefined) {
      query.text = dto.text;
    }
    if (Object.keys(filters).length > 0) {
      query.filters = filters;
    }
    if (dto.page !== undefined) {
      query.page = dto.page;
    }
    if (dto.pageSize !== undefined) {
      query.pageSize = dto.pageSize;
    }
    if (dto.sortBy !== undefined) {
      query.sortBy = dto.sortBy;
    }
    if (dto.sortDirection !== undefined) {
      query.sortDirection = dto.sortDirection;
    }
    return query;
  }

  /**
   * Преобразует DTO действия смены Статуса в доменный {@link StatusAction}.
   *
   * Целевой Статус несёт только `ADMIN_SET` (Req 10.9); прочие действия
   * формируются без поля `target` (учёт `exactOptionalPropertyTypes`).
   */
  private toStatusAction(dto: StatusActionDto): StatusAction {
    if (dto.type === 'ADMIN_SET') {
      return { type: 'ADMIN_SET', target: dto.target as unknown as Status };
    }
    return { type: dto.type } as StatusAction;
  }

  /** Формирует карточку Задачи: насыщенный счётчик и маркер непрочитанного (Req 9.7–9.9). */
  private async toCard(userId: string, task: TaskWithAssignments): Promise<TaskCardView> {
    const messageCount = this.tasksService.saturateMessageCount(task.messageCount);
    const hasUnread = await this.tasksService.hasUnread(userId, task.id);
    return toTaskCard(task, messageCount, hasUnread, this.clock.now());
  }

  /** Формирует детальное представление Задачи с составом участников (Req 2.12). */
  private async toDetail(userId: string, task: TaskWithAssignments): Promise<TaskDetailView> {
    const messageCount = this.tasksService.saturateMessageCount(task.messageCount);
    const hasUnread = await this.tasksService.hasUnread(userId, task.id);
    return toTaskDetail(task, messageCount, hasUnread, this.clock.now());
  }

  /** Доставляет лёгкое realtime-событие об изменении Задачи затронутым Пользователям. */
  private async emitTaskUpdated(
    task: TaskWithAssignments,
    reason: TaskRealtimeReason,
    extraUserIds: readonly string[] = [],
  ): Promise<void> {
    try {
      const admins = await this.userRepository.listActiveWithMaxLink();
      const adminIds = admins.filter((user) => user.role === Role.ADMIN).map((user) => user.id);
      const recipientIds = [
        ...new Set([...this.participantIds(task), ...adminIds, ...extraUserIds]),
      ];
      this.taskRealtime.pushTaskUpdated(task.id, reason, recipientIds);
    } catch (error) {
      this.logger.warn(
        `Не удалось отправить realtime-событие изменения Задачи «${task.id}»: ${String(error)}`,
      );
    }
  }

  /** Возвращает уникальные идентификаторы назначенных участников Задачи. */
  private participantIds(task: TaskWithAssignments): string[] {
    return [
      ...new Set(
        task.assignments
          .filter(
            (assignment) =>
              assignment.kind === AssignmentKind.EXECUTOR ||
              assignment.kind === AssignmentKind.MANAGER,
          )
          .map((assignment) => assignment.userId),
      ),
    ];
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
