import { StatusMachine } from './status.machine';
import { Actor, Status, StatusAction } from './status.types';

describe('StatusMachine', () => {
  const machine = new StatusMachine();

  const ALL_STATUSES: Status[] = ['IN_PROGRESS', 'WAITING', 'DONE', 'NEEDS_ADMIN', 'CANCELLED'];

  describe('onChatMessage (Req 10.1–10.3)', () => {
    it('сообщение Исполнителя в «В работе» переводит в «Ожидает» (Req 10.1)', () => {
      expect(machine.onChatMessage('IN_PROGRESS', 'EXECUTOR')).toBe('WAITING');
    });

    it('сообщение Исполнителя в «Ожидает» сохраняет «Ожидает» (Req 10.1)', () => {
      expect(machine.onChatMessage('WAITING', 'EXECUTOR')).toBe('WAITING');
    });

    it('сообщение Менеджера в «Ожидает» переводит в «В работе» (Req 10.2)', () => {
      expect(machine.onChatMessage('WAITING', 'MANAGER')).toBe('IN_PROGRESS');
    });

    it('сообщение Администратора в «В работе» сохраняет «В работе» (Req 10.2)', () => {
      expect(machine.onChatMessage('IN_PROGRESS', 'ADMIN')).toBe('IN_PROGRESS');
    });

    it.each<[Status, Actor]>([
      ['DONE', 'EXECUTOR'],
      ['DONE', 'MANAGER'],
      ['DONE', 'ADMIN'],
      ['CANCELLED', 'EXECUTOR'],
      ['CANCELLED', 'MANAGER'],
      ['NEEDS_ADMIN', 'EXECUTOR'],
      ['NEEDS_ADMIN', 'ADMIN'],
    ])('в статусе %s сообщение от %s не меняет статус (Req 10.3)', (current, sender) => {
      expect(machine.onChatMessage(current, sender)).toBe(current);
    });
  });

  describe('transition — валидные переходы (Req 10.4–10.10)', () => {
    it('Менеджер: «В работе» → «Выполнено» (Req 10.4)', () => {
      expect(machine.transition('IN_PROGRESS', { type: 'COMPLETE' }, 'MANAGER', false)).toEqual({
        status: 'DONE',
      });
    });

    it('Администратор: «Ожидает» → «Выполнено» (Req 10.4)', () => {
      expect(machine.transition('WAITING', { type: 'COMPLETE' }, 'ADMIN', false)).toEqual({
        status: 'DONE',
      });
    });

    it('Менеджер: «Выполнено» → «В работе» (переоткрытие, Req 10.5)', () => {
      expect(machine.transition('DONE', { type: 'REOPEN' }, 'MANAGER', false)).toEqual({
        status: 'IN_PROGRESS',
      });
    });

    it.each<Status>(['IN_PROGRESS', 'WAITING', 'DONE', 'NEEDS_ADMIN'])(
      'Администратор: %s → «Отменено» (Req 10.6)',
      (current) => {
        expect(machine.transition(current, { type: 'CANCEL' }, 'ADMIN', false)).toEqual({
          status: 'CANCELLED',
        });
      },
    );

    it('Менеджер: «Отменено» → «В работе» (возврат, Req 10.7)', () => {
      expect(machine.transition('CANCELLED', { type: 'RETURN' }, 'MANAGER', false)).toEqual({
        status: 'IN_PROGRESS',
      });
    });

    it.each<Status>(['IN_PROGRESS', 'WAITING'])(
      'Менеджер: %s → «Требует администратора» (Req 10.8)',
      (current) => {
        expect(machine.transition(current, { type: 'REQUEST_ADMIN' }, 'MANAGER', false)).toEqual({
          status: 'NEEDS_ADMIN',
        });
      },
    );

    it.each<Status>(['IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'])(
      'Администратор из «Требует администратора» выбирает %s (Req 10.9)',
      (target) => {
        expect(
          machine.transition('NEEDS_ADMIN', { type: 'ADMIN_SET', target }, 'ADMIN', false),
        ).toEqual({ status: target });
      },
    );

    it('Менеджер снимает «Требует администратора» без проверки → «В работе» (Req 10.10)', () => {
      expect(machine.transition('NEEDS_ADMIN', { type: 'CLEAR_ADMIN' }, 'MANAGER', false)).toEqual({
        status: 'IN_PROGRESS',
      });
    });
  });

  describe('transition — NO_PERMISSION (Req 10.14)', () => {
    const actorActions: StatusAction[] = [
      { type: 'COMPLETE' },
      { type: 'REOPEN' },
      { type: 'CANCEL' },
      { type: 'RETURN' },
      { type: 'REQUEST_ADMIN' },
      { type: 'CLEAR_ADMIN' },
      { type: 'ADMIN_SET', target: 'IN_PROGRESS' },
    ];

    it.each(actorActions)('Исполнитель не вправе выполнять %p', (action) => {
      // Берём статус, из которого действие иначе было бы валидным.
      expect(machine.transition('NEEDS_ADMIN', action, 'EXECUTOR', false)).toEqual({
        error: 'NO_PERMISSION',
      });
    });

    it('Менеджер не вправе выполнять ADMIN_SET (только Администратор, Req 10.9)', () => {
      expect(
        machine.transition('NEEDS_ADMIN', { type: 'ADMIN_SET', target: 'DONE' }, 'MANAGER', false),
      ).toEqual({ error: 'NO_PERMISSION' });
    });

    it('Менеджер не вправе отменять задачу', () => {
      expect(machine.transition('IN_PROGRESS', { type: 'CANCEL' }, 'MANAGER', false)).toEqual({
        error: 'NO_PERMISSION',
      });
    });
  });

  describe('transition — INVALID_TRANSITION (Req 10.15)', () => {
    it('переоткрытие не из «Выполнено» недопустимо (Req 10.5)', () => {
      expect(machine.transition('IN_PROGRESS', { type: 'REOPEN' }, 'MANAGER', false)).toEqual({
        error: 'INVALID_TRANSITION',
      });
    });

    it('«Выполнено» из «Отменено» недопустимо (Req 10.4)', () => {
      expect(machine.transition('CANCELLED', { type: 'COMPLETE' }, 'ADMIN', false)).toEqual({
        error: 'INVALID_TRANSITION',
      });
    });

    it('Администратор не может выбрать «Требует администратора» из «Требует администратора» (Req 10.9)', () => {
      expect(
        machine.transition(
          'NEEDS_ADMIN',
          { type: 'ADMIN_SET', target: 'NEEDS_ADMIN' },
          'ADMIN',
          false,
        ),
      ).toEqual({ error: 'INVALID_TRANSITION' });
    });

    it('Менеджер не может снять «Требует администратора» при установленном признаке проверки (Req 10.10)', () => {
      expect(machine.transition('NEEDS_ADMIN', { type: 'CLEAR_ADMIN' }, 'MANAGER', true)).toEqual({
        error: 'INVALID_TRANSITION',
      });
    });

    it('Администратор может задать «В работе» при установленном признаке проверки через ADMIN_SET (Req 10.9)', () => {
      expect(
        machine.transition(
          'NEEDS_ADMIN',
          { type: 'ADMIN_SET', target: 'IN_PROGRESS' },
          'ADMIN',
          true,
        ),
      ).toEqual({ status: 'IN_PROGRESS' });
    });
  });

  describe('стабильность при нейтральных событиях (Req 10.11, 10.12)', () => {
    // Наступление Дедлайна (10.11) и изменение параметров Задачи (10.12) — это
    // нейтральные события: они не являются переходами автомата и статус не меняют.
    it.each<Status>(ALL_STATUSES)('нейтральное событие сохраняет статус %s', (current) => {
      expect(machine.onNeutralEvent(current)).toBe(current);
    });
  });
});
