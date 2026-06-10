import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTaskList, useChangeStatus, type ListFilters } from "./queries";
import type { TaskListItem } from "../../shared/schemas";

const STATUS_RU: Record<string, string> = {
  NEW: "Новая",
  IN_PROGRESS: "В работе",
  DONE: "Выполнена",
  CANCELLED: "Отменена",
};

function fmtMoscow(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export function TaskList({ filters }: { filters: ListFilters }) {
  const q = useTaskList(filters);
  const parentRef = useRef<HTMLDivElement>(null);
  const changeStatus = useChangeStatus(() => {
    // RU toast on conflict (toast lib wired in App)
    window.dispatchEvent(new CustomEvent("toast", { detail: "Задача изменена, обновлено" }));
  });

  const rows: TaskListItem[] = q.data?.pages.flatMap((p) => p.items) ?? [];

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  // Prefetch next keyset page when nearing the end.
  useEffect(() => {
    const items = rowVirtualizer.getVirtualItems();
    const last = items[items.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 10 && q.hasNextPage && !q.isFetchingNextPage) {
      q.fetchNextPage();
    }
  }, [rowVirtualizer.getVirtualItems(), rows.length, q.hasNextPage, q.isFetchingNextPage]);

  if (q.isLoading) {
    return (
      <div aria-busy="true" className="space-y-2 p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-[70vh] overflow-auto"
      role="list"
      aria-label="Список задач"
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const t = rows[vi.index];
          return (
            <div
              key={t.id}
              role="listitem"
              className="absolute left-0 top-0 flex w-full items-center gap-3 border-b border-zinc-100 px-3 dark:border-zinc-800"
              style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
            >
              <a
                href={`/tasks/${t.id}`}
                className="w-20 font-mono text-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                №{String(t.public_no).padStart(6, "0")}
              </a>
              <span className="flex-1 truncate">{t.title}</span>
              {t.is_overdue && (
                <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-100">
                  Просрочена
                </span>
              )}
              <select
                aria-label={`Статус задачи №${t.public_no}`}
                className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
                value={t.status}
                onChange={(e) =>
                  changeStatus.mutate({ id: t.id, version: t.version, status: e.target.value as any })
                }
              >
                {Object.entries(STATUS_RU).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <span className="w-40 text-right text-sm text-zinc-500">{fmtMoscow(t.deadline)}</span>
            </div>
          );
        })}
      </div>
      {q.isFetchingNextPage && <div className="p-2 text-center text-sm text-zinc-500">Загрузка…</div>}
    </div>
  );
}
