import { useEffect, useState } from "react";
import { Bell, BellSlash } from "@phosphor-icons/react";
import { getTaskMaxNotifications, updateTaskMaxNotifications } from "@/lib/chat-api";

export function TaskMaxNotificationsButton({ taskId }: { taskId: string }): JSX.Element | null {
  const [muted, setMuted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTaskMaxNotifications(taskId)
      .then((result) => {
        if (!cancelled) setMuted(result.muted);
      })
      .catch(() => {
        if (!cancelled) setMuted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (muted === null) {
    return null;
  }
  const label = muted ? "Включить уведомления MAX для задачи" : "Отключить уведомления MAX для задачи";
  return (
    <>
      <button
        className="btn btn--sm task-max-notifications"
        type="button"
        aria-label={label}
        title={label}
        disabled={busy}
        onClick={() => {
          const next = !muted;
          setBusy(true);
          setFailed(false);
          void updateTaskMaxNotifications(taskId, next)
            .then((result) => setMuted(result.muted))
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        {muted ? <BellSlash size={17} aria-hidden="true" /> : <Bell size={17} aria-hidden="true" />}
      </button>
      {failed && <span className="sr-only" role="alert">Не удалось изменить уведомления MAX.</span>}
    </>
  );
}
