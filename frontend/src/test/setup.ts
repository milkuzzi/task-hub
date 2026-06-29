/**
 * Глобальная настройка тестового окружения клиента (задача 20.7).
 *
 * - подключает матчеры `@testing-library/jest-dom` (например, `toBeInTheDocument`);
 * - инициализирует i18next с локалью `ru`, чтобы компоненты, использующие
 *   `useTranslation`, отображали реальные русские подписи;
 * - очищает DOM после каждого теста, чтобы рендеры не пересекались.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Инициализация i18next (единственная локаль `ru`) — побочный эффект импорта.
import "../i18n";

vi.stubEnv("VITE_SOCKET_DISABLED", "true");
vi.stubEnv("VITE_SOCKET_URL", "disabled");

// jsdom не реализует Object URL API. Аутентифицированная загрузка медиа
// («fetch-as-blob») оборачивает байты в Object URL, поэтому подменяем
// `createObjectURL`/`revokeObjectURL` детерминированными заглушками.
let objectUrlCounter = 0;
URL.createObjectURL = vi.fn(() => `blob:mock/${(objectUrlCounter += 1)}`);
URL.revokeObjectURL = vi.fn();

afterEach(() => {
  cleanup();
});
