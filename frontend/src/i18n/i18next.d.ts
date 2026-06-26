import type { AppResources } from './ru';

/**
 * Типизация ключей перевода для автодополнения и проверки в `t(...)`.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: AppResources;
  }
}
