import { Module } from '@nestjs/common';
import { SearchService } from './search.service';

/**
 * Модуль поиска, фильтрации и пагинации Задач (Req 18).
 *
 * Предоставляет {@link SearchService}. Опирается на глобальный
 * {@link RepositoriesModule} (инъекция {@link TaskRepository} и
 * {@link UserRepository}), поэтому дополнительных импортов не требует.
 * Видимость, поиск и фильтрация выполняются строго в пределах прав Пользователя
 * (Req 2.8–2.10, 18.1, 18.3).
 */
@Module({
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
