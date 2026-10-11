import { query, transaction } from './db.js';
import {
  AppError,
  assertCanIssue,
  assertCanReturn,
  penalty,
  today,
} from './rules.js';

const selectLoan = `SELECT l.id, l.reader_id AS "readerId", l.copy_id AS "copyId",
 l.issued_at AS "issuedAt", l.due_date AS "dueDate", l.returned_at AS "returnedAt",
 r.name AS "readerName", b.id AS "bookId", b.title AS "bookTitle", b.author,
 c.inventory_number AS "inventoryNumber" FROM loans l
 JOIN readers r ON r.id=l.reader_id JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id`;

const enrich = (row) => ({
  ...row,
  status: row.returnedAt
    ? 'returned'
    : row.dueDate < today()
      ? 'overdue'
      : 'active',
  ...penalty(row.dueDate, row.returnedAt),
});

export const repository = {
  async list({ page, size, status, q }) {
    const where = ` WHERE ($1='' OR ($1='returned' AND l.returned_at IS NOT NULL)
      OR ($1='active' AND l.returned_at IS NULL) OR ($1='overdue' AND l.returned_at IS NULL AND l.due_date<$2::date))
      AND ($3='' OR b.title ILIKE '%' || $3 || '%' OR r.name ILIKE '%' || $3 || '%')`;
    const args = [status, today(), q];

    const count = await query(
      `SELECT count(*)::int AS total FROM loans l JOIN readers r ON r.id=l.reader_id
      JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id` + where,
      args,
    );

    const data = await query(
      selectLoan + where + ' ORDER BY l.id DESC LIMIT $4 OFFSET $5',
      [...args, size, (page - 1) * size],
    );

    return {
      items: data.rows.map(enrich),
      total: count.rows[0].total,
      page,
      size,
    };
  },

  async detail(id) {
    const { rows } = await query(selectLoan + ' WHERE l.id=$1', [id]);

    if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'Выдача не найдена');

    return enrich(rows[0]);
  },

  async readers(q) {
    const { rows } = await query(
      `SELECT r.id,r.name,EXISTS(SELECT 1 FROM loans l WHERE l.reader_id=r.id
      AND l.returned_at IS NULL AND l.due_date<$2::date) AS "hasOverdue"
      FROM readers r WHERE $1='' OR r.name ILIKE '%' || $1 || '%' ORDER BY r.id LIMIT 50`,
      [q, today()],
    );

    return { items: rows };
  },

  async copies(q) {
    const { rows } = await query(
      `SELECT c.id,c.inventory_number AS "inventoryNumber",b.title,b.author
      FROM copies c JOIN books b ON b.id=c.book_id
      WHERE ($1='' OR b.title ILIKE '%' || $1 || '%' OR c.inventory_number ILIKE '%' || $1 || '%')
      AND NOT EXISTS(SELECT 1 FROM loans l WHERE l.copy_id=c.id AND l.returned_at IS NULL)
      ORDER BY c.id LIMIT 50`,
      [q],
    );

    return { items: rows };
  },

  async issue({ readerId, copyId, dueDate }) {
    const id = await transaction(async (sql) => {
      const reader = await sql(
        'SELECT id FROM readers WHERE id=$1 FOR UPDATE',
        [readerId],
      );

      if (!reader.rows.length)
        throw new AppError(404, 'NOT_FOUND', 'Читатель не найден');

      const copy = await sql('SELECT id FROM copies WHERE id=$1 FOR UPDATE', [
        copyId,
      ]);

      if (!copy.rows.length)
        throw new AppError(404, 'NOT_FOUND', 'Экземпляр не найден');

      const checks = await sql(
        `SELECT EXISTS(SELECT 1 FROM loans WHERE reader_id=$1 AND returned_at IS NULL
        AND due_date<$3::date) AS overdue, EXISTS(SELECT 1 FROM loans WHERE copy_id=$2 AND returned_at IS NULL) AS busy`,
        [readerId, copyId, today()],
      );

      assertCanIssue({
        hasOverdue: checks.rows[0].overdue,
        available: !checks.rows[0].busy,
      });

      const { rows } = await sql(
        'INSERT INTO loans(reader_id,copy_id,issued_at,due_date) VALUES($1,$2,$3,$4) RETURNING id',
        [readerId, copyId, today(), dueDate],
      );

      return rows[0].id;
    });

    return this.detail(id);
  },

  async returnLoan(id) {
    await transaction(async (sql) => {
      const { rows } = await sql(
        'SELECT returned_at AS "returnedAt" FROM loans WHERE id=$1 FOR UPDATE',
        [id],
      );

      if (!rows.length)
        throw new AppError(404, 'NOT_FOUND', 'Выдача не найдена');

      assertCanReturn(rows[0]);

      await sql('UPDATE loans SET returned_at=$2 WHERE id=$1', [id, today()]);
    });

    return this.detail(id);
  },

  async summary() {
    const totals = await query(
      `SELECT count(*)::int AS "totalLoans",
      count(*) FILTER(WHERE returned_at IS NULL)::int AS "onLoan",
      count(*) FILTER(WHERE returned_at IS NULL AND due_date<$1::date)::int AS overdue,
      COALESCE(sum(greatest(0,COALESCE(returned_at,$1::date)-due_date)*10),0)::float8 AS "fineRub"
      FROM loans`,
      [today()],
    );

    const popular =
      await query(`SELECT b.id,b.title,count(*)::int AS "loanCount" FROM loans l
      JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      GROUP BY b.id,b.title ORDER BY count(*) DESC,b.id LIMIT 5`);

    return { ...totals.rows[0], popularBooks: popular.rows, asOf: today() };
  },
};
