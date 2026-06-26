export { SearchService } from './search.service';
export { SearchModule } from './search.module';
export {
  SEARCH_TEXT_BOUNDS,
  type SearchQuery,
  type TaskFilters,
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
