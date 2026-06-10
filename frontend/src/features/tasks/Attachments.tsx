import { useRef, useState } from "react";
import { useAttachments, useUpload, useAddLink, useDeleteAttachment } from "./attachments";

function human(n: number | null): string {
  if (!n) return "";
  const u = ["Б", "КБ", "МБ"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function Attachments({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const q = useAttachments(taskId);
  const upload = useUpload(taskId);
  const addLink = useAddLink(taskId);
  const del = useDeleteAttachment(taskId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");

  return (
    <section aria-labelledby="att-h" className="space-y-3">
      <h2 id="att-h" className="font-medium">Вложения</h2>
      {q.isLoading && <p className="text-sm text-zinc-500">Загрузка…</p>}
      <ul className="space-y-1">
        {(q.data ?? []).map((a) => (
          <li key={a.id} className="flex items-center justify-between border-t py-1">
            {a.kind === "file" ? (
              <a className="underline" href={`/api/tasks/${taskId}/attachments/${a.id}/download`}>
                {a.file_name} {a.size_bytes ? `(${human(a.size_bytes)})` : ""}
              </a>
            ) : (
              <a className="underline" href={a.url ?? "#"} target="_blank" rel="noopener noreferrer">
                {a.file_name || a.url}
              </a>
            )}
            {canEdit && (
              <button aria-label="Удалить вложение" className="text-sm text-red-600"
                onClick={() => del.mutate(a.id)}>✕</button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="space-y-2">
          <input ref={fileRef} type="file" aria-label="Файл вложения"
            onChange={(e) => { const fl = e.target.files?.[0]; if (fl) upload.mutate(fl); }} />
          <div className="flex gap-2">
            <input className="flex-1 rounded border px-2 py-1" placeholder="https://ссылка"
              value={link} onChange={(e) => setLink(e.target.value)} aria-label="Ссылка-вложение" />
            <button className="rounded border px-3 py-1"
              onClick={() => { if (link) { addLink.mutate({ url: link }); setLink(""); } }}>
              Добавить ссылку
            </button>
          </div>
          {upload.isError && <p role="alert" className="text-sm text-red-600">Загрузка отклонена (тип/размер)</p>}
        </div>
      )}
    </section>
  );
}
