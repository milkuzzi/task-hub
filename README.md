# Система поручений

Монорепозиторий веб-приложения «Система поручений».

## Структура

- `backend/` — серверная часть на NestJS + TypeScript (strict).
- `frontend/` — клиентская часть на React + TypeScript.
- `prisma/` — схема данных и миграции Prisma (PostgreSQL).

## Скрипты (корень)

- `npm test` — запуск всех тестов backend.
- `npm run test:unit` — модульные тесты backend.
- `npm run test:e2e` — e2e-тесты backend.
- `npm run lint` — линтинг backend.
- `npm run build` — сборка backend.

## Конфигурация

Переменные окружения backend описаны в `backend/.env.example`
(БД, Redis, SendPulse, MAX, S3, пороги напоминаний, лимиты) и валидируются
при старте приложения.
