import { Inject, Injectable, Logger } from '@nestjs/common';
import { AssignmentKind, Prisma, Role, Task, TaskStatus } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  StateConflictException,
  ValidationException,
} from '../common/errors';
import { Page, PaginationQueryDto } from '../common/dto';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { Actor, Status, StatusAction, StatusMachine } from '../status';
import { hasAdminPrivileges, hasManagerPrivileges } from '../users/permissions';
import { AssignmentDto, CreateTaskDto, TASK_PARAM_BOUNDS, UpdateTaskDto } from './dto';
import { saturateMessageCount } from './message-counter';
import { AUDIT_RECORDER, AuditRecorder, TASK_NOTIFIER, TaskNotifier } from './ports';

/**
 * Одно изменение параметра Задачи, вычисленное операцией {@link TasksService.update}.
 * Содержит машинное имя параметра и его прежнее/новое строковое представление
 * для журналирования (Req 20.1).
 */
interface ComputedFieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Нормализованные и проверенные параметры создаваемой Задачи.
 * Получаются из {@link CreateTaskDto} после прикладной валидации границ (Req 9.1).
 */
interface NormalizedTaskInput {
  title: string;
  description: string | null;
  deadline: Date;
  executorIds: string[];
  managerIds: string[];
}

/**
 * Эффективные права Пользователя в контексте конкретной Задачи.
 *
 * - `MANAGER` — права уровня Менеджера Задачи (Администратор или Менеджер,
 *   назначенный Менеджером этой Задачи): просмотр и редактирование, включая
 *   назначение участников (Req 2.7, 2.10).
 * - `EXECUTOR` — права Исполнителя Задачи (в т.ч. Менеджер, назначенный
 *   Исполнителем): просмотр без редактирования (Req 2.4, 2.8).
 * - `NONE` — у Пользователя нет прав на Задачу по его роли и назначениям; её
 *   содержимое не раскрывается (Req 2.12).
 */
type TaskAccess = 'MANAGER' | 'EXECUTOR' | 'NONE';

/**
 * Прикладной сервис управления Задачами (Req 9, 10.12, 10.13, 20).
 *
 * Реализует создание Задачи с валидацией параметров (Req 9.1–9.5), видимость
 * Задач по роли и назначениям (`listVisible`, Req 2.8–2.10), отказ в доступе к
 * чужой Задаче без раскрытия содержимого (`getVisibleTask`, Req 2.12) и
 * назначение участников с правилами ролей (`assign`, Req 2.4–2.7) и изменение
 * параметров Задачи без смены Статуса (`update`, Req 10.12, 10.13).
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly userRepository: UserRepository,
    private readonly config: AppConfigService,
    private readonly messageRepository: MessageRepository,
    @Inject(AUDIT_RECORDER) private readonly auditRecorder: AuditRecorder,
    @Inject(TASK_NOTIFIER) private readonly taskNotifier: TaskNotifier,
    // Конечный автомат статусов (Req 10.4–10.10). Значение по умолчанию —
    // чистый, не имеющий зависимостей {@link StatusMachine} — позволяет
    // инстанцировать сервис в модульных тестах без DI; в приложении Nest
    // подставляет синглтон из импортированного {@link StatusModule}.
    private readonly statusMachine: StatusMachine = new StatusMachine(),
  ) {}

  /**
   * Создаёт Задачу со всеми обязательными параметрами и связанным Чатом
   * (Req 9.1–9.5).
   *
   * Порядок:
   * 1. проверка прав инициатора: создавать Задачи может Пользователь с
   *    привилегиями Менеджера (Менеджер или Администратор, Req 2.3, 9.2);
   * 2. прикладная валидация параметров против границ Req 9.1 (Название 1–200,
   *    Описание 0–5000, Дедлайн задан, Исполнители 1–100, Менеджеры 1–100). При
   *    нарушении выбрасывается {@link ValidationException} с указанием
   *    некорректного параметра ДО любого изменения состояния, поэтому ранее
   *    введённые Менеджером значения не теряются (Req 9.3) — клиент сохраняет
   *    переданный ввод;
   * 3. атомарное создание Задачи единым вложенным запросом: статус «В работе»
   *    (Req 9.4), назначения Исполнителей и Менеджеров и ровно один связанный
   *    Чат (Req 9.5). Вложения хранятся только в Чате — отдельное хранилище
   *    вложений Задачи не создаётся (Req 9.6).
   *
   * @param managerId Идентификатор инициатора (Пользователь с правами Менеджера).
   * @param dto Параметры создаваемой Задачи.
   * @returns Созданная Задача.
   * @throws AccessDeniedException Если инициатор не найден, удалён или не обладает
   *   привилегиями Менеджера (Req 9.2).
   * @throws ValidationException Если отсутствует обязательный параметр или значение
   *   выходит за допустимые границы (Req 9.3).
   */
  async create(managerId: string, dto: CreateTaskDto): Promise<Task> {
    const actor = await this.userRepository.findActiveById(managerId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись инициатора не найдена или удалена.');
    }
    if (!hasManagerPrivileges(actor.role)) {
      throw new AccessDeniedException('Создавать задачи может только Менеджер или Администратор.');
    }

    const input = this.validateAndNormalize(dto, managerId, actor.role);
    await this.enforceNoAdminExecutors(input.executorIds);
    await this.enforceNoAdminManagers(input.managerIds);

    const created = await this.taskRepository.create(this.buildCreateInput(input));

    // Журналируем создание Задачи: фиксируем начальные значения всех параметров
    // и статус как записи Журнала с пустым прежним значением (Req 20.1).
    await this.recordCreation(created, managerId, input);
    await this.notifyInitialAssignments(created.id, input);

    this.logger.log(
      `Создана задача «${created.id}» инициатором «${managerId}»: ` +
        `статус «${created.status}», ${input.executorIds.length} исполнитель(ей), ` +
        `${input.managerIds.length} менеджер(ов), связанный чат создан.`,
    );
    return created;
  }

  /**
   * Изменяет параметры Задачи (Название, Описание, Дедлайн) без смены её Статуса
   * (Req 10.12), журналирует каждое изменение (Req 20.1) и ставит Исполнителям
   * уведомление о правках в течение 5 секунд (Req 10.13).
   *
   * Порядок (любой отказ происходит ДО изменения состояния, поэтому параметры и
   * Статус остаются без изменений):
   * 1. учётная запись инициатора активна, иначе отказ в доступе;
   * 2. Задача существует и доступна инициатору; недоступная Задача не
   *    раскрывается (Req 2.12);
   * 3. инициатор обладает правами Менеджера Задачи. Менеджер, назначенный
   *    Исполнителем, имеет только права Исполнителя и редактировать Задачу не
   *    может (Req 2.4) — для него операция отклоняется;
   * 4. прикладная валидация переданных параметров против границ Req 9.1
   *    (Название 1–200, Описание 0–5000, корректный Дедлайн);
   * 5. вычисление фактически изменённых параметров (поля, чьё новое значение
   *    отличается от текущего). Если изменений нет, состояние, журнал и
   *    уведомления не затрагиваются;
   * 6. обновление параметров БЕЗ поля `status` — Статус сохраняется (Req 10.12);
   * 7. журналирование каждого изменённого параметра (Req 20.1) и постановка
   *    уведомления Исполнителям о правках (Req 10.13). Уведомление ставится в
   *    очередь асинхронно — требование «в течение 5 секунд» обеспечивается
   *    немедленной постановкой, а не ожиданием доставки.
   *
   * Изменение состава участников выполняется отдельной операцией {@link assign}
   * с собственными правилами ролей (Req 2.4–2.7) и здесь не затрагивается.
   *
   * Журналирование и уведомления выполняются через порты {@link AuditRecorder} и
   * {@link TaskNotifier}. До готовности `AuditLogModule` (задача 8.1) и
   * `NotificationsModule` (задачи 12.x) к ним привязаны безопасные заглушки;
   * реальные реализации будут подключены позднее без изменения этого кода.
   *
   * @param actorId Идентификатор инициатора правки.
   * @param taskId Идентификатор изменяемой Задачи.
   * @param patch Частичный набор изменяемых параметров.
   * @returns Задача с обновлёнными параметрами и неизменным Статусом.
   * @throws AccessDeniedException Инициатор не активен либо не имеет прав
   *   Менеджера Задачи (в т.ч. назначен Исполнителем, Req 2.4).
   * @throws EntityNotFoundException Задача недоступна инициатору (Req 2.12).
   * @throws ValidationException Значение переданного параметра выходит за
   *   допустимые границы (Req 9.1).
   */
  async update(actorId: string, taskId: string, patch: UpdateTaskDto): Promise<Task> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись инициатора не найдена или удалена.');
    }

    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const access = task === null ? 'NONE' : this.resolveAccess(actor.role, actorId, task);
    if (task === null || access === 'NONE') {
      // Чужая Задача не раскрывается (Req 2.12).
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    if (access !== 'MANAGER') {
      // Менеджер, назначенный Исполнителем, имеет права Исполнителя и не может
      // редактировать Задачу (Req 2.4).
      throw new AccessDeniedException('Недостаточно прав для изменения параметров задачи.');
    }

    const changes = this.computeParameterChanges(task, patch);
    if (changes.length === 0) {
      // Нет фактических изменений: состояние, журнал и уведомления не трогаем.
      return task;
    }

    const data: Prisma.TaskUpdateInput = {};
    for (const change of changes) {
      if (change.field === 'title') {
        data.title = change.newValue as string;
      } else if (change.field === 'description') {
        data.description = change.newValue;
      } else if (change.field === 'deadline') {
        data.deadline = new Date(change.newValue as string);
      }
    }

    // Статус намеренно не входит в набор обновляемых полей — он сохраняется
    // при изменении параметров Задачи (Req 10.12).
    const updated = await this.taskRepository.update(taskId, data);

    // Журналируем каждое изменение параметра (Req 20.1).
    for (const change of changes) {
      await this.auditRecorder.record({
        taskId,
        authorId: actorId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      });
    }

    // Ставим Исполнителям уведомление о правках; постановка асинхронна, чтобы
    // уложиться в 5 секунд (Req 10.13).
    const executorIds = task.assignments
      .filter((a) => a.kind === AssignmentKind.EXECUTOR)
      .map((a) => a.userId);
    await this.taskNotifier.enqueueTaskUpdated({
      taskId,
      actorId,
      executorIds,
      changedFields: changes.map((c) => c.field),
    });

    this.logger.log(
      `Изменены параметры задачи «${taskId}» инициатором «${actorId}»: ` +
        `[${changes.map((c) => c.field).join(', ')}]; статус «${updated.status}» сохранён; ` +
        `уведомление поставлено ${executorIds.length} исполнителю(ям).`,
    );
    return updated;
  }

  /**
   * Возвращает постраничный список Задач, видимых Пользователю согласно его
   * доступу и назначениям (Req 2.8, 2.9, 2.10).
   *
   * Администратор видит все Задачи (Req 2.10); остальные Пользователи видят
   * Задачи, где они назначены в любом виде, чтобы список совпадал с прямым
   * доступом к карточке из уведомлений.
   *
   * Тот же набор используется списком Задач Бота MAX (Req 16.7). Список
   * формируется репозиторием с условием видимости и пагинацией, отсортирован
   * по дате создания (новые → старые).
   *
   * @param userId Идентификатор Пользователя, запрашивающего список.
   * @param query Параметры пагинации.
   * @returns Страница видимых Задач (возможно пустая).
   * @throws AccessDeniedException Если учётная запись не найдена или удалена.
   */
  async listVisible(userId: string, query: PaginationQueryDto): Promise<Page<TaskWithAssignments>> {
    const actor = await this.userRepository.findActiveById(userId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись не найдена или удалена.');
    }
    const where = this.buildVisibilityWhere(userId, actor.role);
    return this.taskRepository.list(query, where);
  }

  /**
   * Возвращает Задачу, если она доступна Пользователю по его роли и
   * назначениям; иначе отказывает в доступе, не раскрывая содержимое (Req 2.12).
   *
   * Если у Пользователя нет прав на Задачу (он не Администратор и не назначен
   * на неё Исполнителем/Менеджером) либо Задача не существует, выбрасывается
   * {@link EntityNotFoundException} — единый ответ, не позволяющий отличить
   * «нет доступа» от «не существует» и не раскрывающий параметры Задачи.
   *
   * @param userId Идентификатор Пользователя.
   * @param taskId Идентификатор запрашиваемой Задачи.
   * @returns Задача с её назначениями.
   * @throws AccessDeniedException Если учётная запись не найдена или удалена.
   * @throws EntityNotFoundException Если Задача недоступна Пользователю (Req 2.12).
   */
  async getVisibleTask(userId: string, taskId: string): Promise<TaskWithAssignments> {
    const actor = await this.userRepository.findActiveById(userId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись не найдена или удалена.');
    }
    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    if (task === null || this.resolveAccess(actor.role, userId, task) === 'NONE') {
      // Не раскрываем ни существование, ни содержимое чужой Задачи (Req 2.12).
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    return task;
  }

  /**
   * Авторитетно назначает Исполнителей и Менеджеров Задачи с применением правил
   * ролей (Req 2.4, 2.5, 2.6, 2.7).
   *
   * Порядок проверок (любой отказ происходит ДО изменения состояния, поэтому
   * текущий состав участников остаётся без изменений, Req 2.6):
   * 1. учётная запись инициатора активна, иначе отказ в доступе;
   * 2. Задача существует и доступна инициатору; недоступная Задача не
   *    раскрывается (Req 2.12);
   * 3. инициатор обладает правами Менеджера Задачи. Менеджер, назначенный
   *    Исполнителем, имеет только права Исполнителя и не может редактировать
   *    Задачу (Req 2.4) — для него операция отклоняется;
   * 4. прикладная валидация состава (1–100 Исполнителей и Менеджеров, Req 9.1);
   * 5. правило назначения Менеджера Исполнителем: назначить Пользователя с
   *    привилегиями Менеджера в качестве Исполнителя может только Администратор
   *    (Req 2.5); попытка Менеджера сделать это отклоняется как отсутствие прав
   *    (Req 2.6);
   * 6. атомарная замена состава назначений; несколько Менеджеров получают
   *    равные права (Req 2.7).
   *
   * @param actorId Идентификатор инициатора назначения.
   * @param taskId Идентификатор Задачи.
   * @param assignment Желаемый полный состав Исполнителей и Менеджеров.
   * @returns Задача с обновлённым составом назначений.
   * @throws AccessDeniedException Инициатор не активен, не имеет прав Менеджера
   *   Задачи (в т.ч. назначен Исполнителем, Req 2.4) либо Менеджер пытается
   *   назначить Менеджера Исполнителем (Req 2.6).
   * @throws EntityNotFoundException Задача недоступна инициатору (Req 2.12).
   * @throws ValidationException Нарушены границы состава либо кандидат не найден.
   */
  async assign(
    actorId: string,
    taskId: string,
    assignment: AssignmentDto,
  ): Promise<TaskWithAssignments> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись инициатора не найдена или удалена.');
    }

    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const access = task === null ? 'NONE' : this.resolveAccess(actor.role, actorId, task);
    if (task === null || access === 'NONE') {
      // Чужая Задача не раскрывается (Req 2.12).
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    if (access !== 'MANAGER') {
      // Менеджер, назначенный Исполнителем, имеет права Исполнителя и не может
      // редактировать Задачу (Req 2.4).
      throw new AccessDeniedException('Недостаточно прав для изменения участников задачи.');
    }

    const executorIds = this.validateAssignees(assignment.executorIds, 'Исполнители');
    const managerIds = this.validateAssignees(assignment.managerIds, 'Менеджеры');

    await this.enforceNoAdminExecutors(executorIds);
    await this.enforceNoAdminManagers(managerIds);
    await this.enforceManagerAsExecutorRule(actor.role, executorIds);

    const updated = await this.taskRepository.replaceAssignments(taskId, executorIds, managerIds);

    // Журналируем изменение состава участников: отдельная запись для Исполнителей
    // и для Менеджеров, если соответствующий состав фактически изменился (Req 20.1).
    await this.recordAssignmentChanges(task, actorId, executorIds, managerIds);
    await this.notifyAssignmentChanges(task, taskId, executorIds, managerIds);

    this.logger.log(
      `Обновлён состав задачи «${taskId}» инициатором «${actorId}»: ` +
        `${executorIds.length} исполнитель(ей), ${managerIds.length} менеджер(ов).`,
    );
    return updated;
  }

  /**
   * Выполняет ручной переход Статуса Задачи через конечный автомат и сохраняет
   * результат (Req 10.4–10.10, 10.14, 10.15, 20.1).
   *
   * Порядок (любой отказ происходит ДО изменения состояния, поэтому Статус и
   * Журнал остаются без изменений):
   * 1. учётная запись инициатора активна, иначе отказ в доступе;
   * 2. Задача существует и доступна инициатору; недоступная Задача не
   *    раскрывается (Req 2.12) — отказ в виде «не найдена»;
   * 3. разрешение роли инициатора в контексте Задачи в термины автомата
   *    ({@link Actor}): Администратор → `ADMIN` (обладает правом `ADMIN_SET`,
   *    Req 10.9); Менеджер Задачи → `MANAGER`; Исполнитель (в т.ч. Менеджер,
   *    назначенный Исполнителем, Req 2.4) → `EXECUTOR`;
   * 4. переход через {@link StatusMachine.transition} с учётом признака проверки
   *    Администратором (`adminReviewed`, Req 10.10). Отказ автомата:
   *    `NO_PERMISSION` → {@link AccessDeniedException} (Req 10.14);
   *    `INVALID_TRANSITION` → {@link StateConflictException} (HTTP 409, Req 10.15);
   * 5. при успехе — сохранение нового Статуса (`setStatus`) и запись смены
   *    Статуса в Журнал изменений (поле `status`, прежний → новый, Req 20.1).
   *
   * Возвращает Задачу с назначениями (повторная выборка) для построения
   * детального представления.
   *
   * После успешного сохранения и журналирования через порт {@link TaskNotifier}
   * ставится уведомление Исполнителям и Менеджерам с новым Статусом (Req 13.6).
   *
   * @param actorId Идентификатор инициатора смены Статуса.
   * @param taskId Идентификатор Задачи.
   * @param action Действие смены Статуса (Req 10.4–10.10).
   * @returns Задача с обновлённым Статусом и назначениями.
   * @throws AccessDeniedException Инициатор не активен либо не имеет прав на
   *   действие (Req 10.14).
   * @throws EntityNotFoundException Задача недоступна инициатору (Req 2.12).
   * @throws StateConflictException Переход недопустим из текущего Статуса (Req 10.15).
   */
  async changeStatus(
    actorId: string,
    taskId: string,
    action: StatusAction,
  ): Promise<TaskWithAssignments> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись инициатора не найдена или удалена.');
    }

    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    const actorRole = task === null ? null : this.resolveStatusActor(actor.role, actorId, task);
    if (task === null || actorRole === null) {
      // Чужая Задача не раскрывается (Req 2.12).
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }

    const result = this.statusMachine.transition(
      task.status as Status,
      action,
      actorRole,
      task.adminReviewed,
    );
    if ('error' in result) {
      if (result.error === 'NO_PERMISSION') {
        // Нет прав на ручную смену Статуса (Req 10.14).
        throw new AccessDeniedException('Недостаточно прав для смены статуса задачи.');
      }
      // Недопустимый переход из текущего Статуса (Req 10.15) — конфликт состояния.
      throw new StateConflictException(
        'Недопустимый переход статуса из текущего состояния задачи.',
      );
    }

    const previousStatus = task.status;
    const nextStatus = result.status as TaskStatus;
    await this.taskRepository.setStatus(taskId, nextStatus);

    // Журналируем смену Статуса (Req 20.1).
    await this.auditRecorder.record({
      taskId,
      authorId: actorId,
      field: 'status',
      oldValue: previousStatus,
      newValue: nextStatus,
    });

    const executorIds = task.assignments
      .filter((assignment) => assignment.kind === AssignmentKind.EXECUTOR)
      .map((assignment) => assignment.userId);
    const managerIds = task.assignments
      .filter((assignment) => assignment.kind === AssignmentKind.MANAGER)
      .map((assignment) => assignment.userId);
    await this.taskNotifier.enqueueStatusChanged?.({
      taskId,
      actorId,
      newStatus: nextStatus,
      taskTitle: task.title,
      executorIds,
      managerIds,
    });

    this.logger.log(
      `Статус задачи «${taskId}» изменён инициатором «${actorId}» (роль в задаче ${actorRole}): ` +
        `«${previousStatus}» → «${nextStatus}» по действию «${action.type}».`,
    );

    // Повторная выборка с назначениями для построения детального представления.
    const refreshed = await this.taskRepository.findByIdWithAssignments(taskId);
    if (refreshed === null) {
      throw new EntityNotFoundException('Задача не найдена или недоступна.');
    }
    return refreshed;
  }

  /**
   * Применяет насыщение к фактическому числу Сообщений и возвращает значение
   * счётчика для карточки Задачи (Req 9.7, 9.9).
   *
   * Тонкая обёртка над чистой функцией {@link saturateMessageCount},
   * подставляющая потолок из конфигурации (`limits.messageCounterCap`, по
   * умолчанию 9999). Результат — целое число в диапазоне 0–потолок.
   *
   * @param actualCount Фактическое число Сообщений в Чате Задачи.
   * @returns Отображаемое значение счётчика 0–9999 (с насыщением на потолке).
   */
  saturateMessageCount(actualCount: number): number {
    return saturateMessageCount(actualCount, this.config.limits.messageCounterCap);
  }

  /**
   * Увеличивает счётчик Сообщений Задачи на единицу с насыщением на потолке
   * (Req 9.6, 9.7, 9.9).
   *
   * Используется при добавлении Сообщения в Чат Задачи. Новое значение
   * вычисляется как `min(текущее + 1, потолок)`. Если счётчик уже достиг
   * потолка (9999), значение не меняется и обновление хранилища не
   * выполняется — дальнейшее увеличение отображаемого значения прекращается
   * (Req 9.9).
   *
   * @param taskId Идентификатор Задачи.
   * @returns Задача с актуальным значением счётчика.
   * @throws EntityNotFoundException Если Задача не найдена.
   */
  async incrementMessageCount(taskId: string): Promise<Task> {
    const task = await this.taskRepository.findById(taskId);
    if (task === null) {
      throw new EntityNotFoundException('Задача не найдена.');
    }
    const next = this.saturateMessageCount(task.messageCount + 1);
    if (next === task.messageCount) {
      // Достигнут потолок: прекращаем дальнейшее обновление счётчика (Req 9.9).
      return task;
    }
    return this.taskRepository.update(taskId, { messageCount: next });
  }

  /**
   * Пересчитывает счётчик Сообщений Задачи по фактическому числу Сообщений в
   * Чате и сохраняет насыщенное значение (Req 9.6, 9.7, 9.9).
   *
   * Авторитетный путь обновления при любом изменении числа Сообщений (например,
   * после удаления): фактическое число подсчитывается в хранилище, затем
   * приводится к диапазону 0–9999. Запись выполняется только при изменении
   * хранимого значения.
   *
   * @param taskId Идентификатор Задачи.
   * @returns Задача с актуальным значением счётчика.
   * @throws EntityNotFoundException Если Задача не найдена.
   */
  async refreshMessageCount(taskId: string): Promise<Task> {
    const task = await this.taskRepository.findById(taskId);
    if (task === null) {
      throw new EntityNotFoundException('Задача не найдена.');
    }
    const actual = await this.messageRepository.countByTask(taskId);
    const displayed = this.saturateMessageCount(actual);
    if (displayed === task.messageCount) {
      return task;
    }
    return this.taskRepository.update(taskId, { messageCount: displayed });
  }

  /**
   * Сообщает, есть ли в Чате Задачи хотя бы одно Сообщение, не отмеченное
   * прочитанным указанным Пользователем (Req 9.8).
   *
   * Используется для отображения маркера непрочитанного на карточке Задачи.
   * Маркер показывается тогда и только тогда, когда результат `true` —
   * существует Сообщение Чата Задачи без отметки прочтения данным
   * Пользователем (см. {@link MessageRepository.countUnreadForUserByTask}).
   *
   * @param userId Идентификатор Пользователя.
   * @param taskId Идентификатор Задачи.
   * @returns `true`, если есть непрочитанные Пользователем Сообщения; иначе `false`.
   */
  async hasUnread(userId: string, taskId: string): Promise<boolean> {
    const unread = await this.messageRepository.countUnreadForUserByTask(userId, taskId);
    return unread > 0;
  }

  /**
   * Формирует условие видимости Задач для запроса репозитория по роли и
   * назначениям Пользователя (Req 2.7–2.10).
   *
   * Администратор видит все Задачи (Req 2.10). Остальные Пользователи видят
   * Задачи, где они назначены в любом виде: список не должен расходиться с
   * прямым доступом к карточке из уведомления.
   */
  private buildVisibilityWhere(userId: string, role: Role): Prisma.TaskWhereInput {
    if (hasAdminPrivileges(role)) {
      return {}; // Администратор видит все Задачи (Req 2.10).
    }
    return { assignments: { some: { userId } } };
  }

  /**
   * Определяет эффективные права Пользователя в контексте Задачи (Req 2.4, 2.8,
   * 2.10).
   *
   * Администратор всегда обладает правами Менеджера Задачи. Для остальных права
   * определяются видом назначения на эту Задачу: назначение Менеджером даёт
   * права Менеджера; назначение Исполнителем — права Исполнителя (даже если
   * глобальная роль Пользователя — Менеджер, Req 2.4). Отсутствие назначения
   * означает отсутствие доступа.
   */
  private resolveAccess(role: Role, userId: string, task: TaskWithAssignments): TaskAccess {
    if (hasAdminPrivileges(role)) {
      return 'MANAGER';
    }
    const own = task.assignments.filter((a) => a.userId === userId);
    if (own.some((a) => a.kind === AssignmentKind.MANAGER)) {
      return 'MANAGER';
    }
    if (own.some((a) => a.kind === AssignmentKind.EXECUTOR)) {
      return 'EXECUTOR';
    }
    return 'NONE';
  }

  /**
   * Разрешает роль инициатора в контексте Задачи в термины конечного автомата
   * статусов {@link Actor} (Req 2.3, 2.4, 10.9).
   *
   * Администратор всегда действует как `ADMIN` — это сохраняет за ним право на
   * `ADMIN_SET` из «Требует администратора» (Req 10.9). Для остальных роль
   * определяется по виду назначения через {@link resolveAccess}: права уровня
   * Менеджера Задачи → `MANAGER`; права Исполнителя (в т.ч. Менеджер, назначенный
   * Исполнителем, Req 2.4) → `EXECUTOR`. Отсутствие доступа к Задаче → `null`
   * (содержимое не раскрывается, Req 2.12).
   */
  private resolveStatusActor(role: Role, userId: string, task: TaskWithAssignments): Actor | null {
    if (hasAdminPrivileges(role)) {
      return 'ADMIN';
    }
    const access = this.resolveAccess(role, userId, task);
    if (access === 'MANAGER') {
      return 'MANAGER';
    }
    if (access === 'EXECUTOR') {
      return 'EXECUTOR';
    }
    return null;
  }

  /**
   * Применяет правило назначения Менеджера Исполнителем (Req 2.5, 2.6).
   *
   * Назначить Пользователя с привилегиями Менеджера (Менеджер или
   * Администратор) в качестве Исполнителя может только Администратор. Если
   * инициатор не Администратор и хотя бы один кандидат в Исполнители обладает
   * привилегиями Менеджера, операция отклоняется как отсутствие прав (Req 2.6),
   * а так как проверка выполняется до мутации — состав Исполнителей не
   * меняется.
   *
   * @throws ValidationException Если кандидат в Исполнители не найден среди
   *   активных Пользователей.
   * @throws AccessDeniedException Если Менеджер пытается назначить Менеджера
   *   Исполнителем (Req 2.6).
   */
  private async enforceManagerAsExecutorRule(
    actorRole: Role,
    executorIds: string[],
  ): Promise<void> {
    if (hasAdminPrivileges(actorRole)) {
      return; // Администратору разрешено назначать Менеджера Исполнителем (Req 2.5).
    }
    const candidates = await this.userRepository.findManyActiveByIds(executorIds);
    const byId = new Map(candidates.map((u) => [u.id, u]));
    for (const id of executorIds) {
      const candidate = byId.get(id);
      if (candidate === undefined) {
        throw new ValidationException('Назначаемый Исполнитель не найден или удалён.');
      }
      if (hasManagerPrivileges(candidate.role)) {
        // Менеджер не может назначить Менеджера Исполнителем (Req 2.6).
        throw new AccessDeniedException(
          'Назначение Менеджера Исполнителем доступно только Администратору.',
        );
      }
    }
  }

  /**
   * Запрещает назначать Администратора Исполнителем Задачи.
   *
   * Администратор имеет полный доступ к задачам без контекстного назначения;
   * добавление его в исполнители создаёт лишние назначения и уведомления.
   */
  private async enforceNoAdminExecutors(executorIds: string[]): Promise<void> {
    const candidates = await this.userRepository.findManyActiveByIds(executorIds);
    const byId = new Map(candidates.map((u) => [u.id, u]));
    for (const id of executorIds) {
      const candidate = byId.get(id);
      if (candidate === undefined) {
        throw new ValidationException('Назначаемый Исполнитель не найден или удалён.');
      }
      if (hasAdminPrivileges(candidate.role)) {
        throw new ValidationException('Администратор не может быть исполнителем задачи.');
      }
    }
  }

  /**
   * Запрещает назначать Администратора Менеджером Задачи.
   *
   * Администратор и так видит все Задачи и имеет административные права; запись
   * его в `TaskAssignment(kind=MANAGER)` смешивает системную роль с контекстной
   * ролью задачи и приводит к лишним назначениям/уведомлениям.
   */
  private async enforceNoAdminManagers(managerIds: string[]): Promise<void> {
    const candidates = await this.userRepository.findManyActiveByIds(managerIds);
    const byId = new Map(candidates.map((u) => [u.id, u]));
    for (const id of managerIds) {
      const candidate = byId.get(id);
      if (candidate === undefined) {
        throw new ValidationException('Назначаемый Менеджер не найден или удалён.');
      }
      if (hasAdminPrivileges(candidate.role)) {
        throw new ValidationException('Администратор не может быть менеджером задачи.');
      }
    }
  }

  /**
   * Вычисляет фактически изменённые параметры Задачи по частичному набору
   * правок (Req 10.12, 20.1).
   *
   * Обрабатываются только переданные поля `patch`; каждое значение проверяется
   * против границ Req 9.1 теми же валидаторами, что и при создании. В результат
   * попадают лишь параметры, чьё новое значение отличается от текущего, — это
   * исключает «пустые» правки без изменений (журнал и уведомления не
   * порождаются). Значения приводятся к строковому представлению для журнала:
   * Дедлайн — к ISO-8601 (UTC), Описание сохраняет различие пустой строки и
   * отсутствия значения (`null`).
   *
   * @param task Текущее состояние Задачи.
   * @param patch Частичный набор изменяемых параметров.
   * @returns Список фактических изменений (возможно пустой).
   * @throws ValidationException Значение переданного параметра выходит за границы Req 9.1.
   */
  private computeParameterChanges(task: Task, patch: UpdateTaskDto): ComputedFieldChange[] {
    const changes: ComputedFieldChange[] = [];

    if (patch.title !== undefined) {
      const nextTitle = this.validateTitle(patch.title);
      if (nextTitle !== task.title) {
        changes.push({ field: 'title', oldValue: task.title, newValue: nextTitle });
      }
    }

    if (patch.description !== undefined) {
      const nextDescription = this.validateDescription(patch.description);
      if (nextDescription !== task.description) {
        changes.push({
          field: 'description',
          oldValue: task.description,
          newValue: nextDescription,
        });
      }
    }

    if (patch.deadline !== undefined) {
      const nextDeadline = this.validateDeadline(patch.deadline);
      if (nextDeadline.getTime() !== task.deadline.getTime()) {
        changes.push({
          field: 'deadline',
          oldValue: task.deadline.toISOString(),
          newValue: nextDeadline.toISOString(),
        });
      }
    }

    return changes;
  }

  /**
   * Журналирует создание Задачи: добавляет в Журнал изменений по одной записи на
   * каждый начальный параметр (Название, Описание, Дедлайн, Исполнители,
   * Менеджеры) и Статус с пустым прежним значением (`null`) и текущим значением
   * как новым (Req 20.1).
   *
   * Значения приводятся к строковому представлению так же, как при изменении
   * параметров: Дедлайн — к ISO-8601 (UTC), Описание сохраняет различие пустой
   * строки и отсутствия значения (`null`), составы участников — к
   * детерминированной строке идентификаторов.
   *
   * @param task Созданная Задача (источник идентификатора и Статуса).
   * @param authorId Инициатор создания (автор записей Журнала).
   * @param input Нормализованные параметры создаваемой Задачи.
   */
  private async recordCreation(
    task: Task,
    authorId: string,
    input: NormalizedTaskInput,
  ): Promise<void> {
    const initial: ComputedFieldChange[] = [
      { field: 'title', oldValue: null, newValue: input.title },
      { field: 'description', oldValue: null, newValue: input.description },
      { field: 'deadline', oldValue: null, newValue: input.deadline.toISOString() },
      { field: 'executors', oldValue: null, newValue: this.serializeIds(input.executorIds) },
      { field: 'managers', oldValue: null, newValue: this.serializeIds(input.managerIds) },
      { field: 'status', oldValue: null, newValue: task.status },
    ];
    for (const change of initial) {
      await this.auditRecorder.record({ taskId: task.id, authorId, ...change });
    }
  }

  /**
   * Журналирует изменение состава участников Задачи (Req 20.1).
   *
   * Сравнивает прежний состав Исполнителей и Менеджеров (из назначений Задачи до
   * замены) с новым и добавляет в Журнал отдельную запись для каждого
   * фактически изменившегося состава. Если состав не изменился, запись не
   * создаётся. Составы приводятся к детерминированной строке идентификаторов
   * (без повторов, по возрастанию), чтобы сравнение и значения в Журнале не
   * зависели от порядка.
   *
   * @param task Задача с прежним составом назначений (до замены).
   * @param authorId Инициатор изменения (автор записей Журнала).
   * @param executorIds Новый состав Исполнителей.
   * @param managerIds Новый состав Менеджеров.
   */
  private async recordAssignmentChanges(
    task: TaskWithAssignments,
    authorId: string,
    executorIds: string[],
    managerIds: string[],
  ): Promise<void> {
    const previousExecutors = task.assignments
      .filter((a) => a.kind === AssignmentKind.EXECUTOR)
      .map((a) => a.userId);
    const previousManagers = task.assignments
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);

    const composition: Array<{ field: string; previous: string[]; next: string[] }> = [
      { field: 'executors', previous: previousExecutors, next: executorIds },
      { field: 'managers', previous: previousManagers, next: managerIds },
    ];

    for (const { field, previous, next } of composition) {
      const oldValue = this.serializeIds(previous);
      const newValue = this.serializeIds(next);
      if (oldValue !== newValue) {
        await this.auditRecorder.record({ taskId: task.id, authorId, field, oldValue, newValue });
      }
    }
  }

  /** Ставит уведомления о первичных назначениях после создания Задачи. */
  private async notifyInitialAssignments(
    taskId: string,
    input: NormalizedTaskInput,
  ): Promise<void> {
    for (const userId of input.executorIds) {
      await this.taskNotifier.enqueueTaskAssigned?.({
        taskId,
        userId,
        kind: AssignmentKind.EXECUTOR,
        taskTitle: input.title,
      });
    }
    for (const userId of input.managerIds) {
      await this.taskNotifier.enqueueTaskAssigned?.({
        taskId,
        userId,
        kind: AssignmentKind.MANAGER,
        taskTitle: input.title,
      });
    }
  }

  /**
   * Ставит уведомления только по фактической дельте состава: новым назначениям
   * и пользователям, полностью снятым с задачи.
   */
  private async notifyAssignmentChanges(
    previousTask: TaskWithAssignments,
    taskId: string,
    executorIds: string[],
    managerIds: string[],
  ): Promise<void> {
    const previousKeys = new Set(
      previousTask.assignments.map((assignment) =>
        this.assignmentKey(assignment.userId, assignment.kind),
      ),
    );
    const previousUsers = new Set(previousTask.assignments.map((assignment) => assignment.userId));
    const nextAssignments = [
      ...executorIds.map((userId) => ({ userId, kind: AssignmentKind.EXECUTOR })),
      ...managerIds.map((userId) => ({ userId, kind: AssignmentKind.MANAGER })),
    ];
    const nextUsers = new Set(nextAssignments.map((assignment) => assignment.userId));

    for (const assignment of nextAssignments) {
      if (!previousKeys.has(this.assignmentKey(assignment.userId, assignment.kind))) {
        await this.taskNotifier.enqueueTaskAssigned?.({
          taskId,
          ...assignment,
          taskTitle: previousTask.title,
        });
      }
    }

    for (const userId of previousUsers) {
      if (!nextUsers.has(userId)) {
        await this.taskNotifier.enqueueTaskUnassigned?.({
          taskId,
          userId,
          taskTitle: previousTask.title,
        });
      }
    }
  }

  /** Ключ назначения с учётом вида роли в контексте Задачи. */
  private assignmentKey(userId: string, kind: AssignmentKind): string {
    return `${kind}:${userId}`;
  }

  /**
   * Приводит список идентификаторов участников к детерминированному строковому
   * представлению для Журнала: уникальные значения, упорядоченные по
   * возрастанию и соединённые запятой. Обеспечивает сравнение составов и
   * значения в Журнале независимо от исходного порядка.
   */
  private serializeIds(ids: string[]): string {
    return [...new Set(ids)].sort().join(',');
  }

  /**
   * Проверяет параметры Задачи против границ Req 9.1 и возвращает
   * нормализованное представление.
   *
   * Каждое нарушение немедленно прерывает создание {@link ValidationException}
   * с сообщением, указывающим конкретный некорректный параметр (Req 9.3).
   * Списки Исполнителей и Менеджеров приводятся к уникальным значениям, чтобы
   * исключить дублирующиеся назначения; границы 1–100 проверяются по числу
   * уникальных Пользователей.
   */
  private validateAndNormalize(
    dto: CreateTaskDto,
    creatorId: string,
    creatorRole: Role,
  ): NormalizedTaskInput {
    const title = this.validateTitle(dto.title);
    const description = this.validateDescription(dto.description);
    const deadline = this.validateDeadline(dto.deadline);
    const executorIds = this.validateAssignees(dto.executorIds, 'Исполнители');
    const managerIds = this.includeCreatorManager(
      this.validateAssignees(dto.managerIds, 'Менеджеры'),
      creatorId,
      creatorRole,
    );

    return { title, description, deadline, executorIds, managerIds };
  }

  /** Проверяет Название (обязательное, 1–200, Req 9.1). */
  private validateTitle(title: unknown): string {
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new ValidationException('Название обязательно для заполнения.');
    }
    const max = this.config.limits.taskTitleMaxLength;
    if (title.length > max) {
      throw new ValidationException(`Название не должно превышать ${max} символов.`);
    }
    return title;
  }

  /** Проверяет Описание (необязательное, 0–5000, Req 9.1). */
  private validateDescription(description: unknown): string | null {
    if (description === undefined || description === null) {
      return null;
    }
    if (typeof description !== 'string') {
      throw new ValidationException('Описание должно быть строкой.');
    }
    const max = this.config.limits.taskDescriptionMaxLength;
    if (description.length > max) {
      throw new ValidationException(`Описание не должно превышать ${max} символов.`);
    }
    return description;
  }

  /** Проверяет Дедлайн (обязательная корректная дата и время, Req 9.1). */
  private validateDeadline(deadline: unknown): Date {
    const parsed =
      deadline instanceof Date
        ? deadline
        : typeof deadline === 'string' || typeof deadline === 'number'
          ? new Date(deadline)
          : null;
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      throw new ValidationException(
        'Дедлайн обязателен и должен быть корректной датой и временем.',
      );
    }
    return parsed;
  }

  /**
   * Проверяет список назначений (Исполнителей/Менеджеров) на обязательность и
   * границы 1–100 по числу уникальных Пользователей (Req 9.1); возвращает
   * список без повторов.
   *
   * @param ids Переданные идентификаторы.
   * @param label Человекочитаемое название параметра для сообщения об ошибке.
   */
  private validateAssignees(ids: unknown, label: 'Исполнители' | 'Менеджеры'): string[] {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new ValidationException(
        `${label}: список обязателен и должен содержать идентификаторы.`,
      );
    }
    const unique = [...new Set(ids as string[])];
    const max = this.config.limits.maxAssigneesPerTask;
    if (unique.length < TASK_PARAM_BOUNDS.assigneesMin) {
      throw new ValidationException(
        `${label}: требуется не менее ${TASK_PARAM_BOUNDS.assigneesMin} Пользователя.`,
      );
    }
    if (unique.length > max) {
      throw new ValidationException(`${label}: число Пользователей не может превышать ${max}.`);
    }
    return unique;
  }

  /**
   * Гарантирует видимость Задачи создающему Пользователю с привилегиями
   * Менеджера: автор создания всегда входит в начальный список Менеджеров.
   */
  private includeCreatorManager(
    managerIds: string[],
    creatorId: string,
    creatorRole: Role,
  ): string[] {
    if (hasAdminPrivileges(creatorRole)) {
      return managerIds;
    }
    const withCreator = [...new Set([...managerIds, creatorId])];
    const max = this.config.limits.maxAssigneesPerTask;
    if (withCreator.length > max) {
      throw new ValidationException(`Менеджеры: число Пользователей не может превышать ${max}.`);
    }
    return withCreator;
  }

  /**
   * Формирует вложенный запрос создания Задачи: назначения Исполнителей и
   * Менеджеров и ровно один связанный Чат (Req 9.4, 9.5). Статус «В работе»
   * задаётся явно, не полагаясь на значение по умолчанию схемы.
   */
  private buildCreateInput(input: NormalizedTaskInput): Prisma.TaskCreateInput {
    const assignments: Prisma.TaskAssignmentCreateWithoutTaskInput[] = [
      ...input.executorIds.map((userId) => ({
        kind: AssignmentKind.EXECUTOR,
        user: { connect: { id: userId } },
      })),
      ...input.managerIds.map((userId) => ({
        kind: AssignmentKind.MANAGER,
        user: { connect: { id: userId } },
      })),
    ];

    return {
      title: input.title,
      description: input.description,
      deadline: input.deadline,
      status: TaskStatus.IN_PROGRESS, // при создании «В работе» (Req 9.4)
      assignments: { create: assignments },
      chat: { create: {} }, // ровно один связанный Чат (Req 9.5)
    };
  }
}
