import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import i18n from 'i18next';

import { TaskFormDialog } from './TaskFormDialog';

// Feature: ui-ux-redesign, Property 15: Бикондиционал занятой кнопки

afterEach(() => {
  cleanup();
});

/**
 * Property 15: Бикондиционал занятой кнопки.
 *
 * Для любого булева состояния `busy` кнопка отправки формы (`button[type=submit]`)
 * отключена тогда и только тогда, когда `busy` истинно, и подпись процесса
 * (`common.saving` — «Сохранение…») отображается тогда и только тогда, когда
 * `busy` истинно (иначе — обычная подпись `common.save`, «Сохранить»).
 *
 * Validates: Requirements 15.3
 */
describe('TaskFormDialog — Property 15', () => {
  it('кнопка отправки отключена ⇔ busy и показывает подпись процесса ⇔ busy', () => {
    const savingLabel = i18n.t('common.saving');
    const saveLabel = i18n.t('common.save');

    fc.assert(
      fc.property(fc.boolean(), (busy) => {
        const { container } = render(
          <TaskFormDialog
            open
            task={null}
            directory={[]}
            busy={busy}
            onSubmit={() => {}}
            onCancel={() => {}}
          />,
        );

        const submit = container.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        expect(submit).not.toBeNull();

        // Бикондиционал отключённости: disabled ⇔ busy.
        expect(submit?.disabled).toBe(busy);

        // Бикондиционал подписи: подпись процесса ⇔ busy.
        if (busy) {
          expect(submit?.textContent).toBe(savingLabel);
        } else {
          expect(submit?.textContent).toBe(saveLabel);
        }

        cleanup();
      }),
      { numRuns: 100 },
    );
  });
});
