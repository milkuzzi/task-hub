/**
 * Минимальный контракт сервиса, необходимый CLI-команде создания первичного
 * администратора. Описан отдельно от {@link UsersService}, чтобы команду можно
 * было модульно тестировать с подменой зависимости без поднятия приложения.
 */
export interface CreatePrimaryAdminPort {
  createPrimaryAdmin(email: string | undefined): Promise<{ email: string }>;
}

/**
 * Абстракция вывода в Консоль сервера (Req 4.2, 4.3, 4.4). Соответствует
 * сигнатурам `console`, что позволяет передавать как реальную консоль, так и
 * мок в тестах.
 */
export interface ConsoleLike {
  log(message: string): void;
  error(message: string): void;
}

/** Код завершения процесса: успех. */
export const EXIT_SUCCESS = 0;
/** Код завершения процесса: ошибка. */
export const EXIT_FAILURE = 1;

/**
 * Извлекает значение обязательного параметра адреса электронной почты из
 * переданных аргументов (Req 4.1).
 *
 * Поддерживаются формы:
 * - позиционный аргумент: `create-admin admin@example.com`;
 * - именованный: `--email=admin@example.com` или `--email admin@example.com`.
 *
 * @param args Аргументы команды (как правило, `process.argv.slice(2)`).
 * @returns Значение адреса либо `undefined`, если параметр не передан.
 */
export function parseEmailArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--email') {
      return args[i + 1];
    }
    if (arg.startsWith('--email=')) {
      return arg.slice('--email='.length);
    }
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return undefined;
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
 * Выполняет сценарий CLI-команды создания первичного администратора (Req 4).
 *
 * Логика полностью детерминирована и не имеет внешних зависимостей помимо
 * переданных {@link CreatePrimaryAdminPort} и {@link ConsoleLike}, что делает её
 * пригодной для модульного тестирования. При успехе выводит подтверждение
 * (Req 4.2), при любой ошибке — сообщение с причиной (Req 4.3, 4.4) и
 * возвращает ненулевой код завершения.
 *
 * @param args Аргументы команды (`process.argv.slice(2)`).
 * @param service Сервис создания администратора.
 * @param output Назначение вывода (консоль или мок).
 * @returns Код завершения процесса: {@link EXIT_SUCCESS} или {@link EXIT_FAILURE}.
 */
export async function runCreateAdmin(
  args: readonly string[],
  service: CreatePrimaryAdminPort,
  output: ConsoleLike,
): Promise<number> {
  const email = parseEmailArg(args);

  try {
    const admin = await service.createPrimaryAdmin(email);
    output.log(`Первичный администратор успешно создан: ${admin.email}`);
    return EXIT_SUCCESS;
  } catch (error) {
    output.error(`Ошибка создания первичного администратора: ${messageOf(error)}`);
    return EXIT_FAILURE;
  }
}
