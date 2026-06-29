import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  attachmentPreviewKind,
  fetchThumbnailBlob,
  formatAttachmentSize,
  genericIconType,
  isDocumentFile,
  isPdfFile,
  isPresentationFile,
  isSpreadsheetFile,
  openAttachment,
  selectRepresentation,
  type GenericIconType,
} from "@/lib/attachments";
import { useAuthedImage } from "@/lib/use-authed-image";
import type { AttachmentMeta } from "@/lib/chat-api";

/**
 * Миниатюра или обобщённый значок Вложения (Req 12.6, 12.7).
 *
 * Для изображений в пределах лимита с сформированной миниатюрой показывается
 * сама миниатюра (Req 12.6); для прочих типов — обобщённый значок,
 * соответствующий типу файла (Req 12.7). Клик открывает Вложение в
 * полноэкранном просмотре с распаковкой на клиенте (Req 12.9).
 */
export interface AttachmentThumbnailProps {
  attachment: AttachmentMeta;
  /** Открыть Вложение (полноэкранный просмотр / скачивание). */
  onOpen: () => void;
}

function FallbackIcon({ icon }: { icon: GenericIconType }): JSX.Element {
  const label = fileIconLabel(icon);
  return (
    <span
      className={`attachment-tile__icon attachment-tile__icon--${icon}`}
      aria-hidden="true"
    >
      <svg className="attachment-tile__icon-svg" viewBox="0 0 48 56" focusable="false">
        <path className="attachment-tile__icon-page" d="M8 2h22l10 10v42H8z" />
        <path className="attachment-tile__icon-fold" d="M30 2v12h10" />
        <rect className="attachment-tile__icon-app" x="4" y="22" width="30" height="24" rx="4" />
        <text
          className="attachment-tile__icon-label"
          x="19"
          y="38"
          textAnchor="middle"
        >
          {label}
        </text>
      </svg>
    </span>
  );
}

function fileIconLabel(icon: GenericIconType): string {
  switch (icon) {
    case "pdf":
      return "PDF";
    case "document":
      return "W";
    case "spreadsheet":
      return "X";
    case "presentation":
      return "P";
    case "image":
      return "IMG";
    case "video":
      return "VID";
    case "audio":
      return "AUD";
    case "archive":
      return "ZIP";
    case "text":
      return "TXT";
    default:
      return "FILE";
  }
}

function VideoPreview({
  attachment,
  fallbackIcon,
}: {
  attachment: AttachmentMeta;
  fallbackIcon: GenericIconType;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let revoke: (() => void) | null = null;

    setUrl(null);
    setFailed(false);

    openAttachment(attachment)
      .then((result) => {
        if (cancelled) {
          result.revoke();
          return;
        }
        revoke = result.revoke;
        setUrl(result.url);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
      if (revoke !== null) {
        revoke();
      }
    };
  }, [attachment]);

  if (failed || url === null) {
    return <FallbackIcon icon={fallbackIcon} />;
  }

  return (
    <>
      <video
        className="attachment-tile__video"
        src={url}
        muted
        playsInline
        preload="metadata"
      />
      <span className="attachment-tile__play" aria-hidden="true" />
    </>
  );
}

function AudioPreview({
  attachment,
  fallbackIcon,
  label,
}: {
  attachment: AttachmentMeta;
  fallbackIcon: GenericIconType;
  label: string;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let revoke: (() => void) | null = null;

    setUrl(null);
    setFailed(false);

    openAttachment(attachment)
      .then((result) => {
        if (cancelled) {
          result.revoke();
          return;
        }
        revoke = result.revoke;
        setUrl(result.url);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
      if (revoke !== null) {
        revoke();
      }
    };
  }, [attachment]);

  if (failed || url === null) {
    return (
      <span className="attachment-tile__audio attachment-tile__audio--loading">
        <FallbackIcon icon={fallbackIcon} />
      </span>
    );
  }

  return (
    <audio
      className="attachment-tile__audio"
      src={url}
      controls
      preload="metadata"
      aria-label={label}
    />
  );
}

export function AttachmentThumbnail({
  attachment,
  onOpen,
}: AttachmentThumbnailProps): JSX.Element {
  const { t } = useTranslation();
  const representation = selectRepresentation(attachment);
  const previewKind = attachmentPreviewKind(attachment);
  const wantsThumbnail = representation.kind === "thumbnail";

  // Миниатюра защищена авторизацией: грузим байты с Bearer-токеном и
  // показываем через Object URL (Req 12.6, 5.7). Для Вложений без превью
  // запрос не выполняется. При 404 (миниатюра не сформирована) падаем на
  // обобщённый значок по типу файла (Req 12.7) — без «битой» картинки.
  const { src } = useAuthedImage(
    wantsThumbnail ? () => fetchThumbnailBlob(attachment.id) : null,
    [attachment.id, wantsThumbnail],
  );
  let fallbackIcon: GenericIconType;
  if (previewKind === "audio") {
    fallbackIcon = "audio";
  } else if (isPdfFile(attachment.mimeType, attachment.originalName)) {
    fallbackIcon = "pdf";
  } else if (isSpreadsheetFile(attachment.mimeType, attachment.originalName)) {
    fallbackIcon = "spreadsheet";
  } else if (isDocumentFile(attachment.mimeType, attachment.originalName)) {
    fallbackIcon = "document";
  } else if (isPresentationFile(attachment.mimeType, attachment.originalName)) {
    fallbackIcon = "presentation";
  } else if (representation.kind === "icon") {
    fallbackIcon = representation.icon;
  } else {
    fallbackIcon = genericIconType(attachment.mimeType, attachment.originalName);
  }
  const title = `${attachment.originalName} · ${formatAttachmentSize(attachment.sizeBytes)}`;

  if (previewKind === "audio") {
    return (
      <span
        className="attachment-tile attachment-tile--audio-player"
        title={title}
      >
        <span className="attachment-tile__preview">
          <AudioPreview
            attachment={attachment}
            fallbackIcon={fallbackIcon}
            label={t("attachment.audioPlayer", {
              name: attachment.originalName,
            })}
          />
        </span>
      </span>
    );
  }

  return (
    <button
      className="attachment-tile"
      type="button"
      onClick={onOpen}
      title={title}
      aria-label={`${t("attachment.open")}: ${attachment.originalName}`}
    >
      <span className="attachment-tile__preview">
        {wantsThumbnail && src !== null ? (
          <img
            className="attachment-tile__img"
            src={src}
            alt={attachment.originalName}
            loading="lazy"
          />
        ) : previewKind === "video" ? (
          <VideoPreview attachment={attachment} fallbackIcon={fallbackIcon} />
        ) : (
          <FallbackIcon icon={fallbackIcon} />
        )}
      </span>
    </button>
  );
}
