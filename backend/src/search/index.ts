export { SearchService } from './search.service';
export { SearchModule } from './search.module';
export {
  SEARCH_TEXT_BOUNDS,
  TASK_SORT_FIELDS,
  TASK_SORT_DIRECTIONS,
  DEFAULT_TASK_SORT,
  type SearchQuery,
  type TaskFilters,
  type TaskSortField,
  type TaskSortDirection,
  type NormalizedSearchQuery,
  type NormalizedTaskFilters,
} from './search.types';
export {
  validateSearchText,
  validateTaskFilters,
  validateSearchQuery,
  buildVisibilityWhere,
  buildSearchWhere,
} from './search-query';
