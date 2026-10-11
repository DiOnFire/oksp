// Run only against the coursework database; temporary fixtures are removed in finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { repository } from '../src/repository.js';
import { pool } from '../src/db.js';
import { today } from '../src/rules.js';

const app = createApp(repository, { user: 'demo', password: 'demo' });

const call = (method, path) => request(app)[method](path).auth('demo', 'demo');

test('PostgreSQL: выдача, конкуренция, запреты, возврат, сводка и фильтры', async () => {
  let readerIds = [],
    bookId,
    copyIds = [];

  try {
    readerIds = (
      await pool.query(
        "INSERT INTO readers(name) VALUES('TEST clean'),('TEST overdue') RETURNING id",
      )
    ).rows.map((r) => r.id);

    bookId = (
      await pool.query(
        "INSERT INTO books(title,author) VALUES('TEST book','TEST author') RETURNING id",
      )
    ).rows[0].id;

    copyIds = (
      await pool.query(
        "INSERT INTO copies(book_id,inventory_number) VALUES($1,'TEST-1'),($1,'TEST-2'),($1,'TEST-3') RETURNING id",
        [bookId],
      )
    ).rows.map((r) => r.id);

    await pool.query(
      'INSERT INTO loans(reader_id,copy_id,issued_at,due_date) VALUES($1,$2,$3::date-10,$3::date-2)',
      [readerIds[1], copyIds[1], today()],
    );

    const payload = {
      readerId: readerIds[0],
      copyId: copyIds[0],
      dueDate: today(),
    };

    const results = await Promise.all([
      call('post', '/api/loans').send(payload),
      call('post', '/api/loans').send(payload),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);

    const loan = results.find((r) => r.status === 201).body;

    assert.equal(loan.bookTitle, 'TEST book');
    assert.equal(loan.fineRub, 0);

    const blocked = await call('post', '/api/loans')
      .send({ readerId: readerIds[1], copyId: copyIds[2], dueDate: today() })
      .expect(409);

    assert.equal(blocked.body.error.code, 'READER_OVERDUE');

    const before = await call('get', '/api/summary').expect(200);
    const returned = await call('post', `/api/loans/${loan.id}/return`).expect(
      200,
    );

    assert.equal(returned.body.returnedAt, today());

    await call('post', `/api/loans/${loan.id}/return`).expect(409);

    const after = await call('get', '/api/summary').expect(200);

    assert.equal(after.body.onLoan, before.body.onLoan - 1);

    const again = await call('post', '/api/loans').send(payload).expect(201);

    assert.notEqual(again.body.id, loan.id);

    const list = await call(
      'get',
      '/api/loans?q=TEST%20book&status=active&size=1',
    ).expect(200);

    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.total, 2);

    const detail = await call('get', `/api/loans/${loan.id}`).expect(200);

    assert.equal(detail.body.status, 'returned');

    const overdue = (
      await pool.query('SELECT id FROM loans WHERE copy_id=$1', [copyIds[1]])
    ).rows[0].id;
    const fine = await call('post', `/api/loans/${overdue}/return`).expect(200);

    assert.equal(fine.body.fineRub, 20);

    const available = await call('get', '/api/copies?q=TEST-2').expect(200);

    assert.equal(available.body.items[0].id, copyIds[1]);

    await call('post', '/api/loans')
      .send({ readerId: 2147483647, copyId: copyIds[2], dueDate: today() })
      .expect(404);
  } finally {
    if (readerIds.length)
      await pool.query('DELETE FROM loans WHERE reader_id=ANY($1::int[])', [
        readerIds,
      ]);

    if (copyIds.length)
      await pool.query('DELETE FROM copies WHERE id=ANY($1::int[])', [copyIds]);

    if (bookId) await pool.query('DELETE FROM books WHERE id=$1', [bookId]);

    if (readerIds.length)
      await pool.query('DELETE FROM readers WHERE id=ANY($1::int[])', [
        readerIds,
      ]);

    await pool.end();
  }
});
