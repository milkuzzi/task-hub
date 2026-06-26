import { Injectable } from '@nestjs/common';
import { Prisma, Task, TaskStatus } from '@prisma/client';
import { AccessDeniedException } from '../common/errors';
import { Page, PAGINATION, PaginationQueryDto } from '../common/dto';
import { TaskRepository, UserRepository } from '../repositories';
import { buildSearchWhere, validateSearchQuery } from './search-query';
import { SearchQuery } from './search.types';

/**
 * Прикладной сервис поиска, фильтрации и пагинации Задач (Req 18).
 *
 * Реализует регистронезависимый подстрочный поиск по Названию/Описанию в
 * пределах видимости Пользователя (Req 18.1), конъюнктивную фильтрацию по
 * Статусу/Дедлайну/участникам (Req 18.3) и постраничный вывод (по умолчанию 20,
 * максимум 100, Req 18.5, 18.6).
 *
 * Вся декидируемая логика — проверка длины строки запроса и значений фильтров и
 * построение Prisma-условия `WHERE` (видимость ∧ текст ∧ фильтры) — вынесена в
 * чистые функции {@link validateSearchQuery} и {@link buildSearchWhere}, что
 * делает её детерминированно тестируемой (свойства 52–54). Сервис лишь проверяет
 * учётную запись, нормализует пагинацию и делегирует выборку репозиторию.
 *
 * Недопустимые параметры (строка запроса вне 1–256, значение фильтра)
 * отклоняются исключением ДО обращения к данным, поэтому текущий список Задач не
 * изменяется (Req 18.2, 18.4, 18.7).
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Выполняет поиск и фильтрацию Задач с пагинацией в пределах видимости
   * Пользователя (Req 18.1–18.7).
   *
   * Порядок (любой отказ происходит ДО обращения к данным, поэтому список не
   * изменяется, Req 18.2, 18.4, 18.7):
   * 1. учётная запись Пользователя активна, иначе отказ в доступе;
   * 2. валидация строки запроса (1–256, Req 18.2) и значений фильтров
   *    (Req 18.4) как единого целого — недопустимость любого параметра
   *    отклоняет весь запрос (Req 18.7);
   * 3. нормализация пагинации: размер страницы по умолчанию 20 и не более 100
   *    (Req 18.5), номер страницы не меньше 1;
   * 4. построение Prisma-условия `WHERE` (видимость ∧ текст ∧ фильтры) и
   *    постраничная выборка. При номере страницы за пределами доступных
   *    возвращается пустой список и корректное общее число найденных Задач
   *    (Req 18.6).
   *
   * @param userId Идентификатор Пользователя, выполняющего поиск.
   * @param query Поисковый запрос: строка, фильтры и параметры пагинации.
   * @returns Страница найденных Задач в пределах видимости (возможно пустая).
   * @throws AccessDeniedException Если учётная запись не найдена или удалена.
   * @throws ValidationException Недопустима строка запроса (Req 18.2) или
   *   значение фильтра (Req 18.4, 18.7).
   */
  async search(userId: string, query: SearchQuery): Promise<Page<Task>> {
    const actor = await this.userRepository.findActiveById(userId);
    if (actor === null) {
      throw new AccessDeniedException('Учётная запись не найдена или удалена.');
    }

    // Декидируемая валидация строки запроса и фильтров (Req 18.2, 18.4, 18.7).
    const normalized = validateSearchQuery(query);

    const pagination = this.resolvePagination(query.page, query.pageSize);
    const where = buildSearchWhere(userId, actor.role, normalized);

    // Отменённые Задачи скрыты из общего списка, но явный фильтр `CANCELLED`
    // открывает отдельный режим просмотра отменённых.
    const requestedCancelled =
      normalized.filters?.statuses?.includes(TaskStatus.CANCELLED) ?? false;
    const listWhere = requestedCancelled ? where : this.withoutCancelled(where);

    return this.taskRepository.list(pagination, listWhere);
  }

  private withoutCancelled(where: Prisma.TaskWhereInput): Prisma.TaskWhereInput {
    const clauses: Prisma.TaskWhereInput[] = Array.isArray(where.AND)
      ? [...where.AND]
      : where.AND === undefined
        ? []
        : [where.AND];
    clauses.push({ status: { not: TaskStatus.CANCELLED } });
    return { ...where, AND: clauses };
  }

  /**
   * Нормализует параметры пагинации к допустимым границам (Req 18.5).
   *
   * Отсутствующий размер страницы заменяется значением по умолчанию (20);
   * размер ограничивается сверху значением 100 и снизу значением 1. Номер
   * страницы не может быть меньше 1. Запрос страницы за пределами доступных
   * корректно обрабатывается репозиторием и {@link buildPage}: возвращается
   * пустой список и полное число найденных Задач (Req 18.6).
   */
  private resolvePagination(
    page: number | undefined,
    pageSize: number | undefined,
  ): PaginationQueryDto {
    const dto = new PaginationQueryDto();
    dto.page = this.clampPage(page);
    dto.pageSize = this.clampPageSize(pageSize);
    return dto;
  }

  /** Приводит номер страницы к значению не меньше 1 (по умолчанию 1). */
  private clampPage(page: number | undefined): number {
    if (page === undefined || !Number.isFinite(page)) {
      return PAGINATION.defaultPage;
    }
    return Math.max(PAGINATION.minPage, Math.floor(page));
  }

  /** Приводит размер страницы к диапазону 1–100 (по умолчанию 20, Req 18.5). */
  private clampPageSize(pageSize: number | undefined): number {
    if (pageSize === undefined || !Number.isFinite(pageSize)) {
      return PAGINATION.defaultPageSize;
    }
    const floored = Math.floor(pageSize);
    return Math.min(PAGINATION.maxPageSize, Math.max(PAGINATION.minPageSize, floored));
  }
}
