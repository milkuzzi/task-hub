import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth-context';
import { router } from '@/router/routes';

/** Корневой компонент приложения: контекст аутентификации + маршрутизатор. */
export function App(): JSX.Element {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
