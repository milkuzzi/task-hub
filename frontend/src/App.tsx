import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Lazy routes -> per-route chunks (≤ 60 KB gzip each).
const TasksPage = lazy(() => import("./features/tasks/TasksPage"));
const TaskCardPage = lazy(() => import("./features/tasks/TaskCardPage"));
const LoginPage = lazy(() => import("./features/auth/LoginPage"));
const AdminPage = lazy(() => import("./features/admin/AdminPage"));

const qc = new QueryClient();

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "light");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);
  return { theme, setTheme };
}

export default function App() {
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    const onLogout = () => (window.location.href = "/login");
    window.addEventListener("auth:logout", onLogout);
    return () => window.removeEventListener("auth:logout", onLogout);
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <header className="flex items-center gap-4 border-b p-3">
          <nav className="flex gap-3" aria-label="Основная навигация">
            <NavLink to="/tasks">Задачи</NavLink>
            <NavLink to="/admin">Реестр</NavLink>
          </nav>
          <button
            className="ml-auto rounded border px-2 py-1"
            aria-label="Переключить тему"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Светлая" : "Тёмная"}
          </button>
        </header>
        <main className="p-3">
          <Suspense fallback={<div className="p-4">Загрузка…</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/tasks" replace />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:id" element={<TaskCardPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </Suspense>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
