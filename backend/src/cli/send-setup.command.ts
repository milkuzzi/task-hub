import { ConsoleLike, EXIT_FAILURE, EXIT_SUCCESS, parseEmailArg } from './create-admin.command';

/**
 * Минимальный контракт сервиса, необходимый CLI-команде отправки ссылки
 * установки пароля. Описан отдельно от {@link import('../auth').AuthService},
 * чтобы команду можно было модульно тестировать с подменой зависимости без
 * поднятия приложения.
 */
export interface SendPasswordSetupPort {
  sendPasswordSetup(email: string): Promise<void>;
}

/**
 * Извлекает человекочитаемое сообщение из перехваченной ошибки для вывода в
 * Консоль сервера, не раскрывая стек.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * Выполняет сценарий CLI-команды отправки ссылки установки пароля (Req 15.1).
 *
 * Логика детерминирована и не имеет внешних зависимостей помимо переданных
 * {@link SendPasswordSetupPort} и {@link ConsoleLike}, что делает её пригодной
 * для модульного тестирования. Принимает обязательный адрес электронной почты
 * (позиционный аргумент либо `--email`), выпускает ссылку и ставит письмо в
 * очередь отправки. При отсутствии адреса или любой ошибке выводит причину и
 * возвращает ненулевой код завершения.
 *
 * @param args Аргументы команды (`process.argv.slice(2)`).
 * @param service Сервис отправки ссылки установки пароля.
 * @param output Назначение вывода (консоль или мок).
 * @returns Код завершения процесса: {@link EXIT_SUCCESS} или {@link EXIT_FAILURE}.
 */
export async function runSendSetup(
  args: readonly string[],
  service: SendPasswordSetupPort,
  output: ConsoleLike,
): Promise<number> {
  const email = parseEmailArg(args);
  if (email === undefined || email.trim() === '') {
    output.error(
      'Не указан адрес электронной почты. Использование: ' +
        'node dist/cli/send-setup.js <email> | --email=<email>',
    );
    return EXIT_FAILURE;
  }

  try {
    await service.sendPasswordSetup(email);
    output.log(`Ссылка установки пароля поставлена в очередь отправки: ${email}`);
    return EXIT_SUCCESS;
  } catch (error) {
    output.error(`Ошибка отправки ссылки установки пароля: ${messageOf(error)}`);
    return EXIT_FAILURE;
  }
}
