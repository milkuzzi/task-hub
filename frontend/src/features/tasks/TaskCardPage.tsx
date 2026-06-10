import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

interface TaskDetail {
  id: string; public_no: number; title: string; description: string | null;
  status: string; owner_id: string; assignee_id: string | null;
  deadline: string | null; is_overdue: boolean; completion_info: string | null;
  version: number; created_at: string; updated_at: string;
}

const STATUS_RU: Record<string, string> = {
  NEW: "Новая", IN_PROGRESS: "В работе", DONE: "Выполнена", CANCELLED: "Отменена",
};

export default function TaskCardPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["task", id],
    queryFn: async () => (await api<TaskDetail>(`/api/tasks/${id}`)).data,
  });

  // Optimistic complete with rollback + RU conflict toast.
  const complete = useMutation({
    mutationFn: async (info: string) => {
      const t = q.data!;
      return (await api<TaskDetail>(`/api/tasks/${id}/complete`, {
        method: "POST",
        body: { version: t.version, completion_info: info },
      })).data;
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["task", id] });
      const prev = qc.getQueryData<TaskDetail>(["task", id]);
      if (prev) qc.setQueryData(["task", id], { ...prev, status: "DONE" });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["task", id], ctx.prev);
      window.dispatchEvent(new CustomEvent("toast", { detail: "Задача изменена, обновлено" }));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["task", id] }),
  });

  if (q.isLoading) return <div aria-busy="true" className="h-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />;
  if (q.isError || !q.data) return <p role="alert">Не удалось загрузить задачу</p>;
  const t = q.data;

  return (
    <article className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">
        №{String(t.public_no).padStart(6, "0")} — {t.title}
      </h1>
      <dl className="grid grid-cols-[160px_1fr] gap-y-2">
        <dt>Статус</dt><dd>{STATUS_RU[t.status]}{t.is_overdue && " · Просрочена"}</dd>
        <dt>Дедлайн</dt><dd>{t.deadline ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "medium", timeStyle: "short" }).format(new Date(t.deadline)) : "—"}</dd>
        <dt>Описание</dt><dd>{t.description || "—"}</dd>
      </dl>

      <div className="flex gap-2">
        <a href={`/api/tasks/${id}/export.pdf`} className="rounded border px-3 py-1">Экспорт в PDF</a>
        {t.status !== "DONE" && t.status !== "CANCELLED" && (
          <button
            className="rounded bg-green-600 px-3 py-1 text-white"
            onClick={() => {
              const info = prompt("Опишите результат выполнения:");
              if (info) complete.mutate(info);
            }}
          >
            Завершить
          </button>
        )}
      </div>

      <section aria-labelledby="history-h">
        <h2 id="history-h" className="font-medium">История</h2>
        <p className="text-sm text-zinc-500">Аудит изменений загружается из /api/tasks/{id}/history</p>
      </section>
    </article>
  );
}
