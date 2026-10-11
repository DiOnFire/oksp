import test from 'node:test';
import assert from 'node:assert/strict';
import {
  penalty,
  assertCanIssue,
  assertCanReturn,
  validDate,
} from '../src/rules.js';

test('Возврат в срок: просрочка и штраф равны нулю', () =>
  assert.deepEqual(penalty('2026-10-08', '2026-10-08'), {
    overdueDays: 0,
    fineRub: 0,
  }));

test('Штраф за три дня после срока равен 30 рублям', () =>
  assert.deepEqual(penalty('2026-10-05', '2026-10-08'), {
    overdueDays: 3,
    fineRub: 30,
  }));

test('Без возврата просрочка считается на дату стенда', () =>
  assert.equal(penalty('2026-10-01', null, '2026-10-08').overdueDays, 7));

test('Будущий срок не создаёт отрицательный штраф', () =>
  assert.equal(penalty('2026-10-10', null, '2026-10-08').fineRub, 0));

test('Свободный экземпляр разрешено выдать читателю без просрочки', () =>
  assert.doesNotThrow(() =>
    assertCanIssue({ available: true, hasOverdue: false }),
  ));

test('Просрочка читателя блокирует выдачу', () =>
  assert.throws(() => assertCanIssue({ available: true, hasOverdue: true }), {
    code: 'READER_OVERDUE',
  }));

test('Занятый экземпляр нельзя выдать повторно', () =>
  assert.throws(() => assertCanIssue({ available: false, hasOverdue: false }), {
    code: 'COPY_BUSY',
  }));

test('Повторный возврат отклоняется', () =>
  assert.throws(() => assertCanReturn({ returnedAt: '2026-10-08' }), {
    code: 'ALREADY_RETURNED',
  }));

test('Невозможная календарная дата отклоняется', () =>
  assert.equal(validDate('2026-02-30'), false));
