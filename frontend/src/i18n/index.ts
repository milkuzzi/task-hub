import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ru } from './ru';

/**
 * Инициализация i18next с единственной локалью `ru` (Req 1.1).
 *
 * Интерполяция значений в React безопасна по умолчанию, поэтому `escapeValue`
 * отключён. Резервная локаль также `ru` — других языков в системе нет.
 */
void i18n.use(initReactI18next).init({
  resources: {
    ru,
  },
  lng: 'ru',
  fallbackLng: 'ru',
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

export default i18n;
