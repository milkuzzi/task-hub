import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  attachmentPreviewKind,
  fetchThumbnailBlob,
  formatAttachmentSize,
  genericIconType,
  iconGlyph,
  isSpreadsheetFile,
  loadSpreadsheetPreview,
  openAttachment,
  selectRepresentation,
  type GenericIconType,
  type SpreadsheetPreview,
} from '@/lib/attachments';
import { useAuthedImage } from '@/lib/use-authed-image';
import type { AttachmentMeta } from '@/lib/chat-api';

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
  return (
    <span className="attachment-tile__icon" aria-hidden="true">
      {iconGlyph(icon)}
    </span>
  );
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

function SpreadsheetPreviewTile({
  attachment,
  fallbackIcon,
}: {
  attachment: AttachmentMeta;
  fallbackIcon: GenericIconType;
}): JSX.Element {
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setPreview(null);
    setFailed(false);

    openAttachment(attachment)
      .then(async (result) => {
        try {
          const spreadsheet = await loadSpreadsheetPreview(result.blob, attachment, {
            maxRows: 4,
            maxColumns: 4,
          });
          if (!cancelled) {
            setPreview(spreadsheet);
          }
        } finally {
          result.revoke();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attachment]);

  if (failed || preview === null || preview.rows.length === 0 || preview.visibleColumns === 0) {
    return <FallbackIcon icon={fallbackIcon} />;
  }

  return (
    <span
      className="attachment-tile__sheet"
      style={{ gridTemplateColumns: `repeat(${preview.visibleColumns}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {preview.rows.map((row, rowIndex) =>
        Array.from({ length: preview.visibleColumns }, (_, columnIndex) => (
          <span
            className="attachment-tile__cell"
            key={`${rowIndex}-${columnIndex}`}
            title={row[columnIndex] ?? ''}
          >
            {row[columnIndex] ?? ''}
          </span>
        )),
      )}
    </span>
  );
}

export function AttachmentThumbnail({
  attachment,
  onOpen,
}: AttachmentThumbnailProps): JSX.Element {
  const { t } = useTranslation();
  const representation = selectRepresentation(attachment);
  const previewKind = attachmentPreviewKind(attachment);
  const wantsThumbnail = representation.kind === 'thumbnail';

  // Миниатюра защищена авторизацией: грузим байты с Bearer-токеном и
  // показываем через Object URL (Req 12.6, 5.7). Для Вложений без превью
  // запрос не выполняется. При 404 (миниатюра не сформирована) падаем на
  // обобщённый значок по типу файла (Req 12.7) — без «битой» картинки.
  const { src } = useAuthedImage(
    wantsThumbnail ? () => fetchThumbnailBlob(attachment.id) : null,
    [attachment.id, wantsThumbnail],
  );
  let fallbackIcon: GenericIconType;
  if (isSpreadsheetFile(attachment.mimeType, attachment.originalName)) {
    fallbackIcon = 'spreadsheet';
  } else if (representation.kind === 'icon') {
    fallbackIcon = representation.icon;
  } else {
    fallbackIcon = genericIconType(attachment.mimeType);
  }

  return (
    <button
      className="attachment-tile"
      type="button"
      onClick={onOpen}
      title={`${attachment.originalName} · ${formatAttachmentSize(attachment.sizeBytes)}`}
      aria-label={`${t('attachment.open')}: ${attachment.originalName}`}
    >
      <span className="attachment-tile__preview">
        {wantsThumbnail && src !== null ? (
          <img
            className="attachment-tile__img"
            src={src}
            alt={attachment.originalName}
            loading="lazy"
          />
        ) : previewKind === 'video' ? (
          <VideoPreview attachment={attachment} fallbackIcon={fallbackIcon} />
        ) : previewKind === 'spreadsheet' ? (
          <SpreadsheetPreviewTile attachment={attachment} fallbackIcon={fallbackIcon} />
        ) : (
          <FallbackIcon icon={fallbackIcon} />
        )}
      </span>
    </button>
  );
}
