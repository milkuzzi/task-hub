import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

export interface Attachment {
  id: string; task_id: string; kind: "file" | "link";
  file_name: string | null; sha256: string | null;
  size_bytes: number | null; url: string | null; created_at: string;
}
interface ListResp { items: Attachment[] }

export function useAttachments(taskId: string) {
  return useQuery({
    queryKey: ["attachments", taskId],
    queryFn: async () => (await api<ListResp>(`/api/tasks/${taskId}/attachments`)).data.items,
  });
}

export function useUpload(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      // multipart upload bypasses the JSON api() wrapper; CSRF via cookie header.
      const fd = new FormData();
      fd.append("file", file);
      const csrf = document.cookie.match("(^|;)\\s*csrf_token=([^;]+)");
      const res = await fetch(`/api/tasks/${taskId}/attachments/upload`, {
        method: "POST", credentials: "include", body: fd,
        headers: csrf ? { "X-CSRF-Token": decodeURIComponent(csrf[2]) } : {},
      });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["attachments", taskId] }),
  });
}

export function useAddLink(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { url: string; file_name?: string }) =>
      (await api<Attachment>(`/api/tasks/${taskId}/attachments/link`, { method: "POST", body: v })).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ["attachments", taskId] }),
  });
}

export function useDeleteAttachment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api(`/api/tasks/${taskId}/attachments/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["attachments", taskId] }),
  });
}
