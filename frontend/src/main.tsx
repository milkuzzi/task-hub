import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/global.css';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Корневой элемент #root не найден');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
