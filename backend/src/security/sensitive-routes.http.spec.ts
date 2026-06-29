import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AttachmentsController } from '../attachments/attachments.controller';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ChatService } from '../chat';
import { AppConfigService } from '../config';
import { UserRepository } from '../repositories';
import { RateLimiter } from './rate-limiter';
import { RateLimitGuard } from './rate-limit.guard';

describe('sensitive HTTP routes', () => {
  const currentUser = {
    id: 'user-1',
    email: 'admin@example.test',
    displayName: 'Admin User',
    role: Role.ADMIN,
    avatarPath: null,
    maxLink: null,
  };

  let app: INestApplication;
  let authService: {
    login: jest.Mock;
    loginWithMax: jest.Mock;
    setPassword: jest.Mock;
    changePassword: jest.Mock;
  };
  let attachmentsService: { uploadToTask: jest.Mock };
  let rateLimiter: { check: jest.Mock };

  beforeEach(async () => {
    authService = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'token',
        tokenId: 'token-1',
        userId: currentUser.id,
        role: Role.ADMIN,
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      loginWithMax: jest.fn().mockResolvedValue({
        accessToken: 'max-token',
        tokenId: 'token-2',
        userId: currentUser.id,
        role: Role.ADMIN,
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      setPassword: jest.fn().mockResolvedValue(undefined),
      changePassword: jest.fn().mockResolvedValue(undefined),
    };
    attachmentsService = {
      uploadToTask: jest.fn().mockResolvedValue({
        attachment: {
          id: 'attachment-1',
          messageId: null,
          originalName: 'note.txt',
          mimeType: 'text/plain',
          sizeBytes: BigInt(5),
          thumbnailPath: null,
          compression: 'gzip',
          checksum: 'checksum',
        },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    };
    rateLimiter = {
      check: jest.fn(),
    };

    const sessionGuard: CanActivate = {
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().user = {
          userId: currentUser.id,
          tokenId: 'token-1',
          role: Role.ADMIN,
        };
        return true;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController, AttachmentsController],
      providers: [
        Reflector,
        RateLimitGuard,
        { provide: RateLimiter, useValue: rateLimiter },
        { provide: AuthService, useValue: authService },
        {
          provide: AppConfigService,
          useValue: {
            app: { publicUrl: 'https://tasks.example.test' },
            max: {
              oauthAuthorizeUrl: 'https://max.example.test/oauth/authorize',
              oauthClientId: 'client-1',
            },
          },
        },
        {
          provide: UserRepository,
          useValue: { findByIdWithMaxLink: jest.fn().mockResolvedValue(currentUser) },
        },
        { provide: ChatService, useValue: {} },
        { provide: AttachmentsService, useValue: attachmentsService },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(sessionGuard)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    await (app as NestFastifyApplication).register(multipart, {
      limits: {
        fieldNameSize: 100,
        fieldSize: 0,
        fields: 0,
        files: 1,
        fileSize: 25 * 1024 * 1024,
        parts: 1,
        headerPairs: 20,
      },
      throwFileSizeLimit: true,
    });
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 429 on repeated login attempts before running login again', async () => {
    rateLimiter.check
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.test', password: 'correct-password' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.test', password: 'correct-password' })
      .expect(429);

    expect(rateLimiter.check).toHaveBeenCalledWith(expect.any(String), 'login');
    expect(authService.login).toHaveBeenCalledTimes(1);
  });

  it('returns 429 on repeated MAX login attempts before running MAX login again', async () => {
    rateLimiter.check
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await request(app.getHttpServer()).post('/auth/max').send({ authCode: 'code-1' }).expect(201);
    await request(app.getHttpServer()).post('/auth/max').send({ authCode: 'code-2' }).expect(429);

    expect(rateLimiter.check).toHaveBeenCalledWith(expect.any(String), 'login');
    expect(authService.loginWithMax).toHaveBeenCalledTimes(1);
  });

  it('returns 429 on repeated password setup attempts before setting a password again', async () => {
    rateLimiter.check
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await request(app.getHttpServer())
      .post('/auth/set-password')
      .send({ token: 'setup-token', password: 'NewPassword123!' })
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/set-password')
      .send({ token: 'setup-token', password: 'NewPassword123!' })
      .expect(429);

    expect(rateLimiter.check).toHaveBeenCalledWith(expect.any(String), 'set_password');
    expect(authService.setPassword).toHaveBeenCalledTimes(1);
  });

  it('returns 429 on repeated password changes before changing a password again', async () => {
    rateLimiter.check
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', 'Bearer token')
      .send({ currentPassword: 'OldPassword123!', newPassword: 'NewPassword123!' })
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', 'Bearer token')
      .send({ currentPassword: 'OldPassword123!', newPassword: 'NewPassword123!' })
      .expect(429);

    expect(rateLimiter.check).toHaveBeenCalledWith(expect.any(String), 'change_password');
    expect(authService.changePassword).toHaveBeenCalledTimes(1);
  });

  it('returns 429 on repeated attachment uploads before storing another file', async () => {
    rateLimiter.check
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await request(app.getHttpServer())
      .post('/tasks/task-1/attachments')
      .attach('file', Buffer.from('hello'), 'note.txt')
      .expect(201);
    await request(app.getHttpServer())
      .post('/tasks/task-1/attachments')
      .attach('file', Buffer.from('hello'), 'note.txt')
      .expect(429);

    expect(rateLimiter.check).toHaveBeenCalledWith(expect.any(String), 'upload');
    expect(attachmentsService.uploadToTask).toHaveBeenCalledTimes(1);
  });
});
