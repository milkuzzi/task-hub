import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UsersService } from '../users';
import { EXIT_FAILURE, runCreateAdmin } from './create-admin.command';

/**
 * Точка входа CLI-команды создания первичного администратора в Консоли сервера
 * (Req 4).
 *
 * Поднимает приложение в режиме контекста (без HTTP-сервера), получает
 * {@link UsersService}, выполняет сценарий и завершает процесс с
 * соответствующим кодом. Контекст приложения всегда закрывается, чтобы
 * освободить подключения к БД/Redis.
 *
 * Использование (после сборки):
 *   node dist/cli/create-admin.js admin@example.com
 *   node dist/cli/create-admin.js --email=admin@example.com
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const usersService = app.get(UsersService);
    const exitCode = await runCreateAdmin(process.argv.slice(2), usersService, console);
    process.exitCode = exitCode;
  } catch (error) {
    // Непредвиденный сбой инфраструктуры (например, недоступность БД).
    console.error(
      `Ошибка создания первичного администратора: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = EXIT_FAILURE;
  } finally {
    await app.close();
  }
}

void bootstrap();
