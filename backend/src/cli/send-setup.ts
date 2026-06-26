import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuthService } from '../auth';
import { EXIT_FAILURE } from './create-admin.command';
import { runSendSetup } from './send-setup.command';

/**
 * Точка входа CLI-команды отправки ссылки установки пароля в Консоли сервера
 * (Req 15.1).
 *
 * Поднимает приложение в режиме контекста (без HTTP-сервера), получает
 * {@link AuthService}, выполняет сценарий и завершает процесс с соответствующим
 * кодом. Контекст приложения всегда закрывается, чтобы освободить подключения к
 * БД/Redis/очереди.
 *
 * Использование (после сборки):
 *   node dist/cli/send-setup.js admin@example.com
 *   node dist/cli/send-setup.js --email=admin@example.com
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const authService = app.get(AuthService);
    const exitCode = await runSendSetup(process.argv.slice(2), authService, console);
    process.exitCode = exitCode;
  } catch (error) {
    // Непредвиденный сбой инфраструктуры (например, недоступность БД/очереди).
    console.error(
      `Ошибка отправки ссылки установки пароля: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = EXIT_FAILURE;
  } finally {
    await app.close();
  }
}

void bootstrap();
