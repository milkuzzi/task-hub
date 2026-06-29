import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import {
  getMaxNotificationSettings,
  pollMaxBotLink,
  startMaxBotLink,
  unlinkMax,
  updateMaxNotificationSettings,
} from "@/lib/auth-api";
import { useAuth } from "@/lib/use-auth";

const MAX_BOT_POLL_INTERVAL_MS = 2_000;
const MAX_BOT_POLL_GRACE_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function openPendingBotWindow(): Window | null {
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function navigateBotWindow(botWindow: Window | null, link: string): void {
  if (botWindow !== null && !botWindow.closed) {
    botWindow.opener = null;
    botWindow.location.href = link;
    botWindow.focus();
    return;
  }

  const opened = window.open(link, "_blank", "noopener,noreferrer");
  if (opened === null) {
    window.location.assign(link);
  }
}

/**
 * Привязка собственного профиля MAX (Req 6.6, 16.2).
 *
 * Отображает текущий статус привязки и кнопку запуска одноразовой привязки
 * через Бота MAX.
 */
export function MaxLinkSection(): JSX.Element {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [notificationsMuted, setNotificationsMuted] = useState<boolean | null>(null);
  const [notificationsBusy, setNotificationsBusy] = useState(false);

  useEffect(() => {
    if (user?.maxLinked !== true) {
      setNotificationsMuted(null);
      return;
    }
    let cancelled = false;
    getMaxNotificationSettings()
      .then((settings) => {
        if (!cancelled) setNotificationsMuted(settings.muted);
      })
      .catch(() => {
        if (!cancelled) setNotificationsMuted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.maxLinked]);

  async function handleLink(): Promise<void> {
    const botWindow = openPendingBotWindow();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const start = await startMaxBotLink();
      navigateBotWindow(botWindow, start.link);

      const expiresAt = Date.parse(start.expiresAt);
      const stopAt = Number.isFinite(expiresAt)
        ? expiresAt + MAX_BOT_POLL_GRACE_MS
        : Date.now() + 10 * 60_000;

      while (Date.now() <= stopAt) {
        await delay(MAX_BOT_POLL_INTERVAL_MS);
        const status = await pollMaxBotLink(start.state);

        if (status.status === "pending") {
          continue;
        }
        if (status.status === "confirmed") {
          botWindow?.close();
          setUser(status.user);
          setSuccess(t("profile.max.linkedSuccess"));
          return;
        }
        if (status.status === "failed") {
          setError(status.reason);
          return;
        }
        setError("Ссылка привязки MAX устарела. Повторите попытку.");
        return;
      }

      setError("Ссылка привязки MAX устарела. Повторите попытку.");
    } catch (err) {
      botWindow?.close();
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error && err.message.trim() !== "") {
        setError(err.message);
      } else {
        setError(t("profile.max.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlink(): Promise<void> {
    setUnlinkBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await unlinkMax();
      setUser(updated);
      setSuccess(t("profile.max.unlinkedSuccess"));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("profile.max.unlinkFailed"),
      );
    } finally {
      setUnlinkBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className={user?.maxLinked === true ? "form-success" : "text-muted"}>
        {user?.maxLinked === true
          ? t("profile.max.linked")
          : t("profile.max.notLinked")}
      </p>
      {busy && <p className="text-muted">{t("profile.max.waiting")}</p>}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success !== null && (
        <p className="form-success" role="status">
          {success}
        </p>
      )}
      {user?.maxLinked !== true && (
        <button
          className="btn"
          type="button"
          onClick={handleLink}
          disabled={busy}
        >
          {busy ? t("profile.max.waiting") : t("profile.max.link")}
        </button>
      )}
      {user?.maxLinked === true && (
        <>
          {notificationsMuted !== null && (
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!notificationsMuted}
                disabled={notificationsBusy}
                onChange={(event) => {
                  const muted = !event.target.checked;
                  setNotificationsBusy(true);
                  void updateMaxNotificationSettings(muted)
                    .then((settings) => setNotificationsMuted(settings.muted))
                    .catch((caught) => {
                      setError(caught instanceof ApiError ? caught.message : t("errors.generic"));
                    })
                    .finally(() => setNotificationsBusy(false));
                }}
              />
              <span>Получать уведомления в MAX</span>
            </label>
          )}
          <button
            className="btn"
            type="button"
            onClick={() => void handleUnlink()}
            disabled={unlinkBusy}
          >
            {unlinkBusy ? t("common.saving") : t("profile.max.unlink")}
          </button>
        </>
      )}
    </div>
  );
}
