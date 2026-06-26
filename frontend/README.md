# Frontend — «Система поручений»

Клиентская часть (React + TypeScript, сборка на Vite). Каркас настроен в
задаче 20.1.

## Возможности каркаса

- **React + TypeScript** (strict), сборка и dev-сервер на **Vite**.
- **Роутинг** — `react-router-dom` (`src/router/routes.tsx`).
- **RU-локализация** — `i18next` + `react-i18next`, единственная локаль `ru`
  (`src/i18n/`), весь текст интерфейса на русском (Req 1.1).
- **Адаптивная сетка** — mobile-first CSS от 320px без горизонтальной прокрутки
  (`src/styles/global.css`, Req 1.5).
- **API-клиент** — axios-обёртка с нормализацией ошибок `{ code, message }`
  и Bearer-токеном сессии (`src/lib/api.ts`).
- **Socket.IO-клиент** — singleton с именами событий, синхронизированными с
  backend (`src/lib/socket.ts`, Req 11.1).
- **Время в MSK** — `formatMsk`/`parseMsk` формата `ДД.ММ.ГГГГ ЧЧ:ММ`
  (`src/lib/time.ts`, Req 1.2).

## Команды

```bash
npm run dev        # дев-сервер Vite (порт 5173, прокси /api и /socket.io → backend)
npm run build      # типизация (tsc -b) + production-сборка Vite
npm run typecheck  # только проверка типов
npm run lint       # ESLint
```

## Переменные окружения

См. `.env.example`. Основные: `VITE_API_BASE_URL`, `VITE_SOCKET_URL`,
`VITE_BACKEND_URL` (цель dev-прокси).

Экраны (вход/профиль, администрирование, задачи, чат, статистика) реализуются
в задачах 20.2–20.6.
