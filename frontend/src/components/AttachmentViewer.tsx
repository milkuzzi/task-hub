import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  attachmentPreviewKind,
  fetchDocumentPreviewBlob,
  formatAttachmentSize,
  openAttachment,
  type AttachmentPreviewKind,
} from "@/lib/attachments";
import type { AttachmentMeta } from "@/lib/chat-api";
import { useFocusTrap } from "./useFocusTrap";

function usesPdfDocumentPreview(previewKind: AttachmentPreviewKind): boolean {
  return (
    previewKind === "pdf" ||
    previewKind === "spreadsheet" ||
    previewKind === "document" ||
    previewKind === "presentation"
  );
}

function isLikelyMobileMaxWebView(surface: "site" | "max"): boolean {
  if (surface !== "max" || typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(userAgent)) {
    return true;
  }

  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return false;
  }

  return (
    window.matchMedia("(pointer: coarse)").matches &&
    window.matchMedia("(max-width: 820px)").matches
  );
}

/**
 * Полноэкранный просмотр Вложения с распаковкой на клиенте (Req 12.9).
 *
 * При открытии загружает сжатый поток Вложения, распаковывает его на стороне
 * клиента без потерь и отображает поддержанный предпросмотр: изображение,
 * видео, аудио или серверный PDF-рендер документа (Req 12.9). Целостность
 * распакованного содержимого сверяется с контрольной суммой для исходных медиа; при
 * несовпадении показывается предупреждение, но доступный предпросмотр всё равно
 * отображается. Для типов без предпросмотра предлагается скачивание.
 *
 * Object URL освобождается при закрытии/смене Вложения, чтобы не накапливать
 * память.
 */
export interface AttachmentViewerProps {
  /** Просматриваемое Вложение или `null`, если просмотр закрыт. */
  attachment: AttachmentMeta | null;
  /** Визуальная среда: обычный сайт или MAX mini-app. */
  surface?: "site" | "max";
  onClose: () => void;
}

export function AttachmentViewer({
  attachment,
  surface = "site",
  onClose,
}: AttachmentViewerProps): JSX.Element | null {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrityOk, setIntegrityOk] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Захват фокуса, цикл Tab/Shift+Tab, возврат фокуса и закрытие по Escape
  // (Req 11.2–11.5). `active` завязан на наличие просматриваемого Вложения.
  useFocusTrap({
    active: attachment !== null,
    containerRef: dialogRef,
    onEscape: onClose,
  });

  useEffect(() => {
    if (attachment === null) {
      return;
    }

    let revoked = false;
    let revoke: (() => void) | null = null;
    const previewKind = attachmentPreviewKind(attachment);

    setUrl(null);
    setError(null);
    setIntegrityOk(true);
    setLoading(false);

    if (previewKind === "download") {
      // Предпросмотр недоступен — предложим скачивание (Req 12.7).
      return;
    }

    if (usesPdfDocumentPreview(previewKind) && isLikelyMobileMaxWebView(surface)) {
      return;
    }

    setLoading(true);
    if (usesPdfDocumentPreview(previewKind)) {
      fetchDocumentPreviewBlob(attachment.id)
        .then((blob) => {
          if (revoked) {
            return;
          }
          const previewUrl = URL.createObjectURL(blob);
          revoke = () => URL.revokeObjectURL(previewUrl);
          setUrl(previewUrl);
        })
        .catch(() => {
          if (!revoked) {
            setError(t("attachment.viewer.error"));
          }
        })
        .finally(() => {
          if (!revoked) {
            setLoading(false);
          }
        });

      return () => {
        revoked = true;
        if (revoke !== null) {
          revoke();
        }
      };
    }

    openAttachment(attachment)
      .then((result) => {
        if (revoked) {
          result.revoke();
          return;
        }
        revoke = result.revoke;
        setIntegrityOk(result.integrityOk);
        setUrl(result.url);
      })
      .catch(() => {
        if (!revoked) {
          setError(t("attachment.viewer.error"));
        }
      })
      .finally(() => {
        if (!revoked) {
          setLoading(false);
        }
      });

    return () => {
      revoked = true;
      if (revoke !== null) {
        revoke();
      }
    };
  }, [attachment, surface, t]);

  if (attachment === null) {
    return null;
  }

  const previewKind = attachmentPreviewKind(attachment);
  const documentPreview = usesPdfDocumentPreview(previewKind);
  const maxMobileDocumentFallback =
    documentPreview && isLikelyMobileMaxWebView(surface);

  /**
   * Скачивает Вложение через авторизованный клиент с распаковкой на стороне
   * клиента. Прямая ссылка `<a href>` на защищённый эндпоинт не годится: при
   * нативной навигации не отправляется Bearer-токен (он не в cookie), а сервер
   * отдаёт сжатый поток. Поэтому скачиваем уже распакованный Blob (Req 12.8/12.9).
   */
  const handleDownload = async (): Promise<void> => {
    if (downloading) {
      return;
    }
    setError(null);
    setDownloading(true);
    let revoke: (() => void) | null = null;
    try {
      let href = documentPreview ? null : url;
      if (href === null) {
        const result = await openAttachment(attachment);
        href = result.url;
        revoke = result.revoke;
      }
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = attachment.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      setError(t("attachment.viewer.error"));
    } finally {
      // Освобождаем временный URL после старта скачивания (если создавали свой).
      if (revoke !== null) {
        window.setTimeout(revoke, 10_000);
      }
      setDownloading(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={t("attachment.viewer.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="viewer__head">
          <span className="viewer__file">
            <span className="viewer__name">{attachment.originalName}</span>
            <span className="viewer__meta">
              {formatAttachmentSize(attachment.sizeBytes)}
            </span>
          </span>
          <span className="viewer__actions">
            <button
              className="btn btn--sm"
              type="button"
              disabled={downloading}
              aria-busy={downloading}
              onClick={() => void handleDownload()}
            >
              {downloading
                ? t("attachment.viewer.loading")
                : t("attachment.download")}
            </button>
            <button className="btn btn--sm" type="button" onClick={onClose}>
              {t("attachment.viewer.close")}
            </button>
          </span>
        </header>

        <div
          className={
            documentPreview
              ? "viewer__body viewer__body--document"
              : "viewer__body"
          }
        >
          {loading && (
            <p className="text-muted">{t("attachment.viewer.loading")}</p>
          )}
          {error !== null && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!integrityOk && url !== null && (
            <p className="form-error" role="alert">
              {t("attachment.viewer.integrityWarning")}
            </p>
          )}
          {previewKind === "image" && url !== null && (
            <img
              className="viewer__img"
              src={url}
              alt={attachment.originalName}
            />
          )}
          {previewKind === "video" && url !== null && (
            <video className="viewer__video" src={url} controls playsInline />
          )}
          {previewKind === "audio" && url !== null && (
            <audio
              className="viewer__audio"
              src={url}
              controls
              preload="metadata"
            />
          )}
          {maxMobileDocumentFallback && error === null && (
            <div className="viewer__document-fallback">
              <p className="text-muted">
                {t("attachment.viewer.maxMobileDocumentUnsupported")}
              </p>
              <button
                className="btn btn--primary"
                type="button"
                disabled={downloading}
                aria-busy={downloading}
                onClick={() => void handleDownload()}
              >
                {downloading
                  ? t("attachment.viewer.loading")
                  : t("attachment.download")}
              </button>
            </div>
          )}
          {documentPreview && !maxMobileDocumentFallback && url !== null && (
            <iframe
              className="viewer__document-frame"
              src={url}
              title={`${t("attachment.viewer.documentPreview")}: ${attachment.originalName}`}
            />
          )}
          {previewKind === "download" && !loading && (
            <p className="text-muted">
              {t("attachment.viewer.notPreviewable")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
