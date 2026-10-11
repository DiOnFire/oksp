export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function today() {
  return process.env.APP_TODAY || new Date().toISOString().slice(0, 10);
}

export function penalty(dueDate, returnedAt = null, asOf = today()) {
  const overdueDays = Math.max(
    0,
    Math.round(
      (Date.parse(returnedAt || asOf) - Date.parse(dueDate)) / 86400000,
    ),
  );

  return { overdueDays, fineRub: overdueDays * 10 };
}

export function assertCanIssue({ available, hasOverdue }) {
  if (hasOverdue)
    throw new AppError(
      409,
      'READER_OVERDUE',
      'У читателя есть просроченная выдача',
    );

  if (!available) throw new AppError(409, 'COPY_BUSY', 'Экземпляр уже выдан');
}

export function assertCanReturn(loan) {
  if (loan.returnedAt)
    throw new AppError(409, 'ALREADY_RETURNED', 'Экземпляр уже возвращён');
}

export function positiveInt(value, name, max = 2147483647) {
  if (
    !['string', 'number'].includes(typeof value) ||
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > max
  )
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `${name}: требуется целое число от 1 до ${max}`,
    );

  return Number(value);
}
