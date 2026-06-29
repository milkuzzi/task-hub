import fc from 'fast-check';
import { MaxLink, Role, User } from '@prisma/client';
import {
  AccessDeniedException,
  StateConflictException,
  ValidationException,
} from '../common/errors';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { SUPPORTED_AVATAR_MIME_TYPES, validateAvatar } from './avatar';
import { MaxProfile, UploadedFile } from './profile.types';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 17: Валидация аватара и привязки MAX**
 *
 * Property 17 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 6.4, 6.5, 6.6, 6.9**:
 *
 * Для любого загружаемого аватара или попытки привязки профиля MAX операция
 * отклоняется и ранее сохранённые данные профиля не меняются, если аватар
 * превышает 5 МБ либо имеет неподдерживаемый формат, либо профиль MAX чужой или
 * привязка не удалась.
 *
 * Тест реализует ровно одно свойство (Property 17) и проверяет обе его грани —
 * аватар и привязку MAX. В качестве эталона («оракула») валидации аватара
 * используется чистая функция {@link validateAvatar}; для MAX корректность
 * определяется по правилам Req 6.6/6.9. Граница БД ({@link UserRepository}) и
 * хранилище ({@link AvatarStorage}) подменяются stateful-моками в памяти —
 * обращений к реальной базе/диску нет. Не менее 100 итераций на каждую грань.
 */
describe('Property 17: Валидация аватара и привязки MAX (Req 6.4, 6.5, 6.6, 6.9)', () => {
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const INITIAL_AVATAR_PATH = 'avatars/initial/original.png';

  /**
   * Stateful in-memory подмена {@link UserRepository}, достаточная для
   * {@link UsersService.setAvatar} и {@link UsersService.linkMax}. Хранит
   * состояние пользователей и привязок MAX, чтобы можно было проверить, что при
   * отклонении операции «ранее сохранённые данные профиля не меняются».
   */
  class InMemoryUserRepo {
    readonly users = new Map<string, User>();
    readonly maxLinksByMaxUserId = new Map<string, MaxLink>();
    readonly maxLinksByUserId = new Map<string, MaxLink>();

    seedUser(user: User): void {
      this.users.set(user.id, user);
    }

    seedMaxLink(link: MaxLink): void {
      this.maxLinksByMaxUserId.set(link.maxUserId, link);
      this.maxLinksByUserId.set(link.userId, link);
    }

    async findActiveById(id: string): Promise<User | null> {
      const user = this.users.get(id);
      if (user === undefined || user.deletedAt !== null) {
        return null;
      }
      return user;
    }

    async update(id: string, data: { avatarPath?: string }): Promise<User> {
      const current = this.users.get(id);
      if (current === undefined) {
        throw new Error(`Пользователь «${id}» не найден в моке.`);
      }
      const updated: User = {
        ...current,
        ...(data.avatarPath !== undefined ? { avatarPath: data.avatarPath } : {}),
      };
      this.users.set(id, updated);
      return updated;
    }

    async findMaxLinkByMaxUserId(maxUserId: string): Promise<MaxLink | null> {
      return this.maxLinksByMaxUserId.get(maxUserId) ?? null;
    }

    async upsertMaxLink(userId: string, maxUserId: string): Promise<MaxLink> {
      const link = { id: `link-${userId}`, userId, maxUserId } as unknown as MaxLink;
      this.maxLinksByMaxUserId.set(maxUserId, link);
      this.maxLinksByUserId.set(userId, link);
      return link;
    }

    runInTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    }
  }

  const makeUser = (id: string): User =>
    ({
      id,
      email: `${id}@example.com`,
      displayName: id,
      role: Role.EXECUTOR,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      avatarPath: INITIAL_AVATAR_PATH,
    }) as unknown as User;

  const makeService = (repo: InMemoryUserRepo, storedPath: string) => {
    const store = jest.fn().mockResolvedValue(storedPath);
    const service = new UsersService(
      repo as unknown as UserRepository,
      {
        findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
        setStatus: jest.fn(),
      } as unknown as TaskRepository,
      { revokeAllSessions: jest.fn() } as unknown as AuthService,
      { enqueue: jest.fn() } as unknown as MailerService,
      { now: jest.fn(() => new Date()) } as unknown as ClockService,
      { limits: { avatarMaxBytes: AVATAR_MAX_BYTES } } as unknown as AppConfigService,
      { store } as unknown as AvatarStorage,
    );
    return { service, store };
  };

  // ---------------------------------------------------------------------------
  // Грань A: валидация аватара (Req 6.4, 6.5, 6.9)
  // ---------------------------------------------------------------------------

  /** MIME-типы: поддерживаемые растровые + заведомо неподдерживаемые. */
  const mimeTypeArb = fc.oneof(
    fc.constantFrom(...SUPPORTED_AVATAR_MIME_TYPES),
    fc.constantFrom(
      'image/svg+xml',
      'image/tiff',
      'text/plain',
      'application/pdf',
      'application/octet-stream',
      'video/mp4',
      '',
    ),
    fc.string({ minLength: 0, maxLength: 30 }),
  );

  /** Размеры: вокруг границы 5 МБ, включая 0, отрицательные и нечисловые. */
  const sizeArb = fc.oneof(
    fc.integer({ min: 0, max: AVATAR_MAX_BYTES }),
    fc.integer({ min: AVATAR_MAX_BYTES - 16, max: AVATAR_MAX_BYTES + 16 }),
    fc.integer({ min: AVATAR_MAX_BYTES + 1, max: AVATAR_MAX_BYTES * 3 }),
    fc.integer({ min: -1000, max: -1 }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
  );

  const fileArb: fc.Arbitrary<UploadedFile> = fc.record({
    originalName: fc.constantFrom('a.png', 'photo.jpg', 'icon.webp', 'file', 'data.bin'),
    mimeType: mimeTypeArb,
    sizeBytes: sizeArb,
  });

  // ---------------------------------------------------------------------------
  // Грань B: привязка MAX (Req 6.6, 6.9)
  // ---------------------------------------------------------------------------

  const maxProfileArb: fc.Arbitrary<{
    profile: MaxProfile;
    seedForeignDuplicate: boolean;
  }> = fc
    .record({
      maxUserId: fc.oneof(fc.constant(''), fc.stringMatching(/^max-[a-z0-9]{1,12}$/)),
      verified: fc.boolean(),
      // undefined => владелец не определён (трактуется как свой);
      // 'self' => собственный профиль; 'other' => чужой профиль.
      owner: fc.constantFrom<'undefined' | 'self' | 'other'>('undefined', 'self', 'other'),
      seedForeignDuplicate: fc.boolean(),
    })
    .map(({ maxUserId, verified, owner, seedForeignDuplicate }) => ({
      profile: {
        maxUserId,
        verified,
        ...(owner === 'self'
          ? { ownerUserId: 'self' }
          : owner === 'other'
            ? { ownerUserId: 'other-user' }
            : {}),
      },
      seedForeignDuplicate,
    }));

  // Единая команда Property 17: либо загрузка аватара, либо привязка MAX.
  type AvatarCommand = { kind: 'avatar'; file: UploadedFile };
  type MaxCommand = {
    kind: 'max';
    profile: MaxProfile;
    seedForeignDuplicate: boolean;
  };
  type Command = AvatarCommand | MaxCommand;

  const commandArb: fc.Arbitrary<Command> = fc.oneof(
    fileArb.map((file): Command => ({ kind: 'avatar', file })),
    maxProfileArb.map(({ profile, seedForeignDuplicate }): Command => ({
      kind: 'max',
      profile,
      seedForeignDuplicate,
    })),
  );

  it('операция принимается ⇔ допустимый аватар (формат+размер ≤5 МБ) или свой верифицированный профиль MAX без конфликта; иначе отклоняется без изменения профиля', async () => {
    await fc.assert(
      fc.asyncProperty(commandArb, async (command) => {
        const repo = new InMemoryUserRepo();
        repo.seedUser(makeUser('self'));

        if (command.kind === 'avatar') {
          // --- Грань A: валидация аватара (Req 6.4, 6.5, 6.9) ---
          const oracle = validateAvatar(command.file, AVATAR_MAX_BYTES);
          const newPath = 'avatars/self/new-object.png';
          const { service, store } = makeService(repo, newPath);

          if (oracle.valid) {
            await service.setAvatar('self', 'self', command.file);
            // Принят: путь обновлён, хранилище вызвано один раз (Req 6.4, 6.5).
            expect(store).toHaveBeenCalledTimes(1);
            expect(repo.users.get('self')?.avatarPath).toBe(newPath);
          } else {
            // Отклонён по формату/размеру; данные профиля без изменений (Req 6.9).
            await expect(service.setAvatar('self', 'self', command.file)).rejects.toBeInstanceOf(
              ValidationException,
            );
            expect(store).not.toHaveBeenCalled();
            expect(repo.users.get('self')?.avatarPath).toBe(INITIAL_AVATAR_PATH);
          }
          return;
        }

        // --- Грань B: привязка профиля MAX (Req 6.6, 6.9) ---
        const { profile, seedForeignDuplicate } = command;

        // Возможный конфликт: тот же maxUserId уже привязан к другому пользователю.
        const hasForeignDuplicate = seedForeignDuplicate && profile.maxUserId.length > 0;
        if (hasForeignDuplicate) {
          repo.seedMaxLink({
            id: 'link-other',
            userId: 'other-user',
            maxUserId: profile.maxUserId,
          } as unknown as MaxLink);
        }

        const { service } = makeService(repo, 'unused');

        // Эталон ожидаемого успеха (Req 6.6, 6.9).
        const failedLinkage = !profile.verified || profile.maxUserId.length === 0;
        const foreignProfile = profile.ownerUserId !== undefined && profile.ownerUserId !== 'self';
        const expectSuccess = !failedLinkage && !foreignProfile && !hasForeignDuplicate;

        if (expectSuccess) {
          await service.linkMax('self', profile);
          // Привязан собственный профиль MAX (Req 6.6).
          expect(repo.maxLinksByUserId.get('self')?.maxUserId).toBe(profile.maxUserId);
          expect(repo.maxLinksByMaxUserId.get(profile.maxUserId)?.userId).toBe('self');
        } else {
          // Отклонено: чужой профиль / неуспешная / дублирующая привязка (Req 6.9).
          const rejection =
            foreignProfile && !failedLinkage
              ? AccessDeniedException
              : failedLinkage
                ? ValidationException
                : StateConflictException;
          await expect(service.linkMax('self', profile)).rejects.toBeInstanceOf(rejection);
          // Собственная привязка не появилась.
          expect(repo.maxLinksByUserId.has('self')).toBe(false);
          // Прежнее состояние чужой привязки (если была) не изменилось.
          if (hasForeignDuplicate) {
            expect(repo.maxLinksByMaxUserId.get(profile.maxUserId)?.userId).toBe('other-user');
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
