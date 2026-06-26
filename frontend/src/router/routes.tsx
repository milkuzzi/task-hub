import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { LoginPage } from '@/pages/LoginPage';
import { SetPasswordPage } from '@/pages/SetPasswordPage';
import { MaxCallbackPage } from '@/pages/MaxCallbackPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { TasksPage } from '@/pages/TasksPage';
import { TaskDetailPage } from '@/pages/TaskDetailPage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { StatisticsPage } from '@/pages/StatisticsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

/**
 * Карта маршрутов клиента.
 *
 * Публичные маршруты (вход, установка пароля, OAuth-возврат) доступны без
 * Сессии. Защищённые маршруты (задачи, профиль) оборачиваются `ProtectedRoute`
 * и перенаправляют неаутентифицированных Пользователей на `/login` (Req 5.7).
 * Остальные экраны наполняются в задачах 20.3–20.6.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      // Публичные маршруты аутентификации.
      { path: 'login', element: <LoginPage /> },
      { path: 'set-password', element: <SetPasswordPage /> },
      { path: 'auth/max/callback', element: <MaxCallbackPage purpose="login" /> },

      // Защищённые маршруты (требуют активной Сессии).
      {
        element: <ProtectedRoute />,
        children: [
          { index: true, element: <Navigate to="/tasks" replace /> },
          { path: 'tasks', element: <TasksPage /> },
          { path: 'tasks/:taskId', element: <TaskDetailPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'statistics', element: <StatisticsPage /> },
          { path: 'admin/users', element: <AdminUsersPage /> },
          { path: 'profile', element: <ProfilePage /> },
          { path: 'profile/max/callback', element: <MaxCallbackPage purpose="link" /> },
        ],
      },

      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
