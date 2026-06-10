import { useState } from "react";
import { TaskList } from "./TaskList";
import type { ListFilters, Scope } from "./queries";
import type { TaskStatus } from "../../shared/schemas";

const TABS: { key: Scope; label: string }[] = [
  { key: "created", label: "Созданные" },
  { key: "assigned", label: "Назначенные мне" },
  { key: "watching", label: "Наблюдаю" },
];

export default function TasksPage() {
  const [scope, setScope] = useState<Scope>("created");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [overdue, setOverdue] = useState<boolean | undefined>(undefined);
  const [sort, setSort] = useState<"deadline" | "created_at">("deadline");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const filters: ListFilters = {
    scope,
    status: status || undefined,
    overdue,
    sort,
    dir,
    limit: 50,
  };

  return (
    <section>
      <div role="tablist" aria-label="Категории задач" className="mb-3 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={scope === t.key}
            className={`rounded px-3 py-1 ${scope === t.key ? "bg-blue-600 text-white" : "border"}`}
            onClick={() => setScope(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <form className="mb-3 flex flex-wrap items-center gap-2" role="search">
        <input
          placeholder="Поиск по № (123 / 000123 / №000123)"
          aria-label="Поиск по номеру"
          className="rounded border px-2 py-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value;
              window.location.href = `/api/tasks/search?q=${encodeURIComponent(v)}`;
            }
          }}
        />
        <select aria-label="Статус" className="rounded border px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value as any)}>
          <option value="">Все статусы</option>
          <option value="NEW">Новая</option>
          <option value="IN_PROGRESS">В работе</option>
          <option value="DONE">Выполнена</option>
          <option value="CANCELLED">Отменена</option>
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={overdue === true} onChange={(e) => setOverdue(e.target.checked ? true : undefined)} />
          Только просроченные
        </label>
        <select aria-label="Сортировка" className="rounded border px-2 py-1" value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="deadline">По дедлайну</option>
          <option value="created_at">По дате создания</option>
        </select>
        <button type="button" className="rounded border px-2 py-1" onClick={() => setDir(dir === "asc" ? "desc" : "asc")}>
          {dir === "asc" ? "↑" : "↓"}
        </button>
      </form>
      <TaskList filters={filters} />
    </section>
  );
}
