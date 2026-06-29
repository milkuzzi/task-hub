import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { LoadingState } from "@/components/LoadingState";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LoginPage } from "@/pages/LoginPage";
import { SetPasswordPage } from "@/pages/SetPasswordPage";
import { MaxCallbackPage } from "@/pages/MaxCallbackPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { MaxAppRoot } from "@/components/MaxAppRoot";
import { MaxAppLayout } from "@/components/MaxAppLayout";
import { MaxAdminPage } from "@/pages/MaxAdminPage";

const ProfilePage = lazy(() =>
  import("@/pages/ProfilePage").then((module) => ({
    default: module.ProfilePage,
  })),
);
const TasksPage = lazy(() =>
  import("@/pages/TasksPage").then((module) => ({ default: module.TasksPage })),
);
const TaskDetailPage = lazy(() =>
  import("@/pages/TaskDetailPage").then((module) => ({
    default: module.TaskDetailPage,
  })),
);
const AdminUsersPage = lazy(() =>
  import("@/pages/AdminUsersPage").then((module) => ({
    default: module.AdminUsersPage,
  })),
);
const NotificationsPage = lazy(() =>
  import("@/pages/NotificationsPage").then((module) => ({
    default: module.NotificationsPage,
  })),
);
const StatisticsPage = lazy(() =>
  import("@/pages/StatisticsPage").then((module) => ({
    default: module.StatisticsPage,
  })),
);

function lazyRoute(element: JSX.Element): JSX.Element {
  return (
    <Suspense fallback={<LoadingState label="Загрузка…" />}>{element}</Suspense>
  );
}

/**
 * Карта маршрутов клиента.
 *
 * Публичные маршруты (вход, установка пароля, OAuth-возврат) доступны без
 * Сессии. Защищённые маршруты (задачи, профиль) оборачиваются `ProtectedRoute`
 * и перенаправляют неаутентифицированных Пользователей на `/login` (Req 5.7).
 * Остальные экраны наполняются в задачах 20.3–20.6.
 */
export const router = createBrowserRouter(
  [
    {
      path: "/max",
      element: <MaxAppRoot />,
      children: [
        {
          element: <MaxAppLayout />,
          children: [
            { path: "tasks", element: lazyRoute(<TasksPage />) },
            { path: "tasks/:taskId", element: lazyRoute(<TaskDetailPage />) },
            { path: "notifications", element: lazyRoute(<NotificationsPage />) },
            { path: "admin", element: <MaxAdminPage /> },
            { path: "statistics", element: lazyRoute(<StatisticsPage />) },
            { path: "admin/users", element: lazyRoute(<AdminUsersPage />) },
            { path: "profile", element: lazyRoute(<ProfilePage />) },
          ],
        },
      ],
    },
    {
      path: "/",
      element: <Layout />,
      children: [
        // Публичные маршруты аутентификации.
        { path: "login", element: <LoginPage /> },
        { path: "set-password", element: <SetPasswordPage /> },
        {
          path: "auth/max/callback",
          element: <MaxCallbackPage purpose="login" />,
        },

        // Защищённые маршруты (требуют активной Сессии).
        {
          element: <ProtectedRoute />,
          children: [
            { index: true, element: <Navigate to="/tasks" replace /> },
            { path: "tasks", element: lazyRoute(<TasksPage />) },
            { path: "tasks/:taskId", element: lazyRoute(<TaskDetailPage />) },
            {
              path: "notifications",
              element: lazyRoute(<NotificationsPage />),
            },
            { path: "statistics", element: lazyRoute(<StatisticsPage />) },
            { path: "admin/users", element: lazyRoute(<AdminUsersPage />) },
            { path: "profile", element: lazyRoute(<ProfilePage />) },
            {
              path: "profile/max/callback",
              element: <MaxCallbackPage purpose="link" />,
            },
          ],
        },

        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  },
);
