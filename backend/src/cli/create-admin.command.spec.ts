import {
  ConsoleLike,
  CreatePrimaryAdminPort,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  parseEmailArg,
  runCreateAdmin,
} from './create-admin.command';

describe('parseEmailArg (Req 4.1)', () => {
  it('читает позиционный аргумент', () => {
    expect(parseEmailArg(['admin@example.com'])).toBe('admin@example.com');
  });

  it('читает форму --email=value', () => {
    expect(parseEmailArg(['--email=admin@example.com'])).toBe('admin@example.com');
  });

  it('читает форму --email value', () => {
    expect(parseEmailArg(['--email', 'admin@example.com'])).toBe('admin@example.com');
  });

  it('возвращает undefined при отсутствии аргумента', () => {
    expect(parseEmailArg([])).toBeUndefined();
    expect(parseEmailArg(['--verbose'])).toBeUndefined();
  });
});

describe('runCreateAdmin (Req 4.2, 4.3, 4.4)', () => {
  let output: jest.Mocked<ConsoleLike>;

  beforeEach(() => {
    output = { log: jest.fn(), error: jest.fn() };
  });

  it('выводит подтверждение и код 0 при успехе (Req 4.2)', async () => {
    const service: CreatePrimaryAdminPort = {
      createPrimaryAdmin: jest.fn().mockResolvedValue({ email: 'admin@example.com' }),
    };

    const code = await runCreateAdmin(['admin@example.com'], service, output);

    expect(code).toBe(EXIT_SUCCESS);
    expect(output.log).toHaveBeenCalledTimes(1);
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining('admin@example.com'));
    expect(output.error).not.toHaveBeenCalled();
  });

  it('выводит причину и код 1 при ошибке сервиса (Req 4.3, 4.4)', async () => {
    const service: CreatePrimaryAdminPort = {
      createPrimaryAdmin: jest.fn().mockRejectedValue(new Error('Администратор уже существует.')),
    };

    const code = await runCreateAdmin(['admin@example.com'], service, output);

    expect(code).toBe(EXIT_FAILURE);
    expect(output.error).toHaveBeenCalledTimes(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Администратор уже существует.'),
    );
    expect(output.log).not.toHaveBeenCalled();
  });

  it('передаёт сервису undefined при отсутствии аргумента (Req 4.3)', async () => {
    const createPrimaryAdmin = jest.fn().mockRejectedValue(new Error('нет email'));
    const service: CreatePrimaryAdminPort = { createPrimaryAdmin };

    const code = await runCreateAdmin([], service, output);

    expect(createPrimaryAdmin).toHaveBeenCalledWith(undefined);
    expect(code).toBe(EXIT_FAILURE);
  });
});
