import { PAGINATION } from './pagination';

/**
 * Метаданные страницы результатов (Req 18.5, 18.6).
 *
 * Возвращаются вместе с элементами страницы, чтобы клиент мог отобразить
 * навигацию и общее число найденных записей даже при превышении номера
 * страницы (когда `items` пуст, но `total` ненулевой).
 */
export interface PageMeta {
  /** Текущий номер страницы (начиная с 1). */
  page: number;
  /** Размер страницы. */
  pageSize: number;
  /** Общее число элементов, удовлетворяющих запросу. */
  total: number;
  /** Общее число страниц при данном размере страницы. */
  totalPages: number;
  /** Есть ли следующая страница. */
  hasNext: boolean;
  /** Есть ли предыдущая страница. */
  hasPrevious: boolean;
}

/**
 * Универсальная страница результатов (Req 18.5).
 *
 * @typeParam T Тип элемента страницы (например, задача или сообщение).
 */
export interface Page<T> {
  /** Элементы текущей страницы (возможно пустой массив, Req 18.6). */
  items: T[];
  /** Метаданные пагинации. */
  meta: PageMeta;
}

/**
 * Собирает страницу результатов из элементов и общего числа записей.
 *
 * Корректно обрабатывает пограничный случай превышения номера страницы:
 * `items` может быть пустым, тогда как `total` отражает полное число найденных
 * записей (Req 18.6). Размер страницы и номер берутся такими, какими их запросил
 * клиент после валидации.
 *
 * @param items Элементы текущей страницы.
 * @param total Общее число записей, удовлетворяющих запросу.
 * @param page Номер текущей страницы.
 * @param pageSize Размер страницы.
 */
export function buildPage<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  const safePageSize = pageSize > 0 ? pageSize : PAGINATION.defaultPageSize;
  const totalPages = total === 0 ? 0 : Math.ceil(total / safePageSize);
  return {
    items,
    meta: {
      page,
      pageSize: safePageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > PAGINATION.minPage && total > 0,
    },
  };
}
