import { Injectable } from '@nestjs/common';
import { AssignmentKind, User } from '@prisma/client';
import { ClockService } from '../clock';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { TaskRepository, TaskWithAssignments, UserRepository } from '../repositories';
import { hasAdminPrivileges } from '../users/permissions';
import { AuditFieldChange, AuditRecorder } from '../tasks/ports';
import { AuditEntryRepository } from './audit-entry.repository';
import { AuditLogEntryView } from './audit-log.types';

/**
 * Прикладной сервис Журнала изменений Задачи (Req 20).
 *
 * Реализует порт {@link AuditRecorder}: метод {@link record} добавляет в Журнал
 * неизменяемую запись об одном изменении параметра/статуса Задачи (Req 20.1).
 * Метод {@link list} возвращает все записи Задачи от новых к старым с проверкой
 * прав просмотра — доступ имеют только Менеджер этой Задачи и Администратор
 * (Req 20.2, 20.3).
 *
 * Журнал неизменяем (append-only, Req 20.4): сервис предоставляет лишь
 * добавление и чтение и не имеет операций правки/удаления записей; того же
 * принципа придерживается {@link AuditEntryRepository}.
 *
 * Время изменения хранится в UTC ({@link AuditEntryRepository}); при
 * отображении оно форматируется в MSK через {@link ClockService} (Req 20.1).
 */
@Injectable()
export class AuditLogService implements AuditRecorder {
  constructor(
    private readonly auditEntryRepository: AuditEntryRepository,
    private readonly taskRepository: TaskRepository,
    private readonly userRepository: UserRepository,
    private readonly clock: ClockService,
  ) {}

  /**
   * Добавляет в Журнал изменений неизменяемую запись об одном изменении
   * параметра или статуса Задачи (Req 20.1, 20.4).
   *
   * Момент изменения фиксируется текущим временем из {@link ClockService} и
   * хранится в UTC; представление в MSK выполняется при чтении ({@link list}).
   * Запись только добавляется — операций её правки или удаления не существует
   * (append-only, Req 20.4).
   *
   * @param change Описание изменённого параметра (задача, автор, имя параметра,
   *   прежнее/новое значение).
   */
  async record(change: AuditFieldChange): Promise<void> {
    await this.auditEntryRepository.create({
      taskId: change.taskId,
      authorId: change.authorId,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changedAt: this.clock.now(),
    });
  }

  /**
   * Возвращает все записи Журнала изменений Задачи, упорядоченные от новых к
   * старым, с проверкой прав просмотра (Req 20.2, 20.3).
   *
   * Доступ к Журналу имеют только Менеджер данной Задачи (Пользователь,
   * назначенный на неё Менеджером) и Администратор. Пользователю без этих прав
   * (в т.ч. Исполнителю Задачи или Менеджеру, назначенному на неё Исполнителем)
   * доступ отклоняется (Req 20.3). Момент изменения каждой записи дополняется
   * представлением в MSK (Req 20.1).
   *
   * @param actorId Идентификатор Пользователя, открывающего Журнал.
   * @param taskId Идентификатор Задачи.
   * @returns Записи Журнала (новые → старые) с временем в UTC и MSK.
   * @throws AccessDeniedException Если учётная запись инициатора не найдена/удалена
   *   либо у инициатора нет прав Менеджера данной Задачи или Администратора (Req 20.3).
   * @throws EntityNotFoundException Если Задача не существует.
   */
  async list(actorId: string, taskId: string): Promise<AuditLogEntryView[]> {
    const actor = await this.userRepository.findActiveById(actorId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись не найдена или удалена.');
    }

    const task = await this.taskRepository.findByIdWithAssignments(taskId);
    if (task === null) {
      throw new EntityNotFoundException('Задача не найдена.');
    }

    if (!this.canViewLog(actor, task)) {
      // Журнал доступен только Менеджеру Задачи и Администратору (Req 20.3).
      throw new AccessDeniedException('Недостаточно прав для просмотра журнала изменений задачи.');
    }

    const entries = await this.auditEntryRepository.listByTaskNewestFirst(taskId);
    return entries.map((entry) => ({
      id: entry.id,
      taskId: entry.taskId,
      authorId: entry.authorId,
      field: entry.field,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      changedAt: entry.changedAt,
      changedAtMsk: this.clock.formatMsk(entry.changedAt),
    }));
  }

  /**
   * Определяет, вправе ли Пользователь просматривать Журнал изменений Задачи
   * (Req 20.3).
   *
   * Право имеют Администратор (всегда) и Пользователь, назначенный на Задачу
   * Менеджером. Назначение Исполнителем (в т.ч. для Пользователя с глобальной
   * ролью Менеджера) права на просмотр Журнала не даёт.
   */
  private canViewLog(actor: User, task: TaskWithAssignments): boolean {
    if (hasAdminPrivileges(actor.role)) {
      return true;
    }
    return task.assignments.some(
      (assignment) => assignment.userId === actor.id && assignment.kind === AssignmentKind.MANAGER,
    );
  }
}
