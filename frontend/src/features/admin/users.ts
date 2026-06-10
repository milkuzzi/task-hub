import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export interface UserRow {
  id: string; email: string; full_name: string; is_admin: boolean; is_active: boolean;
}
interface ListResp { items: UserRow[] }

export function useUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => (await api<ListResp>("/api/users")).data.items,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { email: string; full_name: string; is_admin: boolean }) =>
      (await api<UserRow>("/api/users", { method: "POST", body: v })).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; patch: Partial<Pick<UserRow, "full_name" | "is_admin" | "is_active">> }) =>
      (await api<UserRow>(`/api/users/${v.id}`, { method: "PATCH", body: v.patch })).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api(`/api/users/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
