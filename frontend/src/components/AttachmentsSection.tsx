import { useTranslation } from 'react-i18next';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';
import type { AttachmentMeta } from '@/lib/chat-api';

/**
 * Раздел «Вложения» Чата Задачи (Req 11.10).
 *
 * Отображает в одном месте все Вложения данного Чата (множество, равное всем
 * Вложениям всех Сообщений). Каждое Вложение представлено миниатюрой или
 * обобщённым значком (Req 12.6, 12.7); клик открывает полноэкранный просмотр с
 * распаковкой на клиенте (Req 12.9).
 */
export interface AttachmentsSectionProps {
  attachments: AttachmentMeta[];
  loading: boolean;
  onOpen: (attachment: AttachmentMeta) => void;
}

export function AttachmentsSection({
  attachments,
  loading,
  onOpen,
}: AttachmentsSectionProps): JSX.Element {
  const { t } = useTranslation();

  if (loading) {
    return <LoadingState label={t('common.loading')} />;
  }

  if (attachments.length === 0) {
    return <EmptyState message={t('attachment.empty')} />;
  }

  return (
    <section className="panel panel--compact stack">
      <p className="text-muted">{t('attachment.count', { count: attachments.length })}</p>
      <div className="attachment-grid">
        {attachments.map((a) => (
          <AttachmentThumbnail key={a.id} attachment={a} onOpen={() => onOpen(a)} />
        ))}
      </div>
    </section>
  );
}
