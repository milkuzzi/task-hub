import { AppConfigService } from '../../config';
import { PrismaService } from './prisma.service';

/** Заглушка AppConfigService с минимально необходимой секцией database. */
function configWith(url: string): AppConfigService {
  return { database: { url } } as AppConfigService;
}

describe('PrismaService', () => {
  it('строит клиент по строке подключения из конфигурации', () => {
    const service = new PrismaService(configWith('postgresql://u:p@localhost:5432/db'));
    expect(service).toBeInstanceOf(PrismaService);
  });

  it('runInTransaction делегирует выполнение $transaction', async () => {
    const service = new PrismaService(configWith('postgresql://u:p@localhost:5432/db'));

    const txMock = jest.fn().mockResolvedValue('done');
    (service as unknown as { $transaction: typeof txMock }).$transaction = txMock;

    const work = jest.fn();
    const result = await service.runInTransaction(work, { timeout: 1000 });

    expect(result).toBe('done');
    expect(txMock).toHaveBeenCalledWith(work, { timeout: 1000 });
  });
});
