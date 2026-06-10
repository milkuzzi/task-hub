import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  TaskListItem,
  TaskListResponse,
  TaskStatus,
} from "../../shared/schemas";

export type Scope = "created" | "assigned" | "watching";

export interface ListFilters {
  scope: Scope;
  status?: TaskStatus;
  overdue?: boolean;
  sort: "deadline" | "created_at";
  dir: "asc" | "desc";
  limit: number;
}

function qs(f: ListFilters, cursor?: string): string {
  const p = new URLSearchParams();
  p.set("scope", f.scope);
  p.set("sort", f.sort);
  p.set("dir", f.dir);
  p.set("limit", String(f.limit));
  if (f.status) p.set("status", f.status);
  if (f.overdue !== undefined) p.set("overdue", String(f.overdue));
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function tasksKey(f: ListFilters) {
  return ["tasks", f.scope, f.status ?? "", f.overdue ?? "", f.sort, f.dir] as const;
}

// Keyset infinite query — next page is driven by next_cursor (no offset).
export function useTaskList(f: ListFilters) {
  return useInfiniteQuery({
    queryKey: tasksKey(f),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await api<TaskListResponse>(`/api/tasks?${qs(f, pageParam)}`, { signal });
      return data;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 5_000,
  });
}

// Optimistic status change with rollback + RU toast on 409.
export function useChangeStatus(onConflict: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; version: number; status: TaskStatus }) => {
      const { data } = await api<TaskListItem>(`/api/tasks/${v.id}/change-status`, {
        method: "POST",
        body: { version: v.version, status: v.status },
      });
      return data;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const snapshot = qc.getQueriesData<{ pages: TaskListResponse[] }>({ queryKey: ["tasks"] });
      qc.setQueriesData<any>({ queryKey: ["tasks"] }, (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg: TaskListResponse) => ({
            ...pg,
            items: pg.items.map((it) => (it.id === v.id ? { ...it, status: v.status } : it)),
          })),
        };
      });
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshot?.forEach(([key, data]: any) => qc.setQueryData(key, data));
      onConflict();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
