import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/rules.js';

const loan = {
  id: 1,
  readerId: 1,
  copyId: 2,
  issuedAt: '2026-10-08',
  dueDate: '2099-10-22',
  returnedAt: null,
  bookTitle: 'Книга',
  readerName: 'Читатель',
  overdueDays: 0,
  fineRub: 0,
  status: 'active',
};

const app = createApp(
  {
    list: async (args) => ({ items: [loan], total: 1, ...args }),

    detail: async (id) => {
      if (id !== 1) throw new AppError(404, 'NOT_FOUND', 'Не найдено');

      return loan;
    },

    readers: async () => ({
      items: [{ id: 1, name: 'Читатель', hasOverdue: false }],
    }),

    copies: async () => ({
      items: [
        { id: 2, title: 'Книга', inventoryNumber: 'INV-2', author: 'Автор' },
      ],
    }),

    issue: async () => loan,

    returnLoan: async () => ({
      ...loan,
      returnedAt: '2026-10-08',
      status: 'returned',
    }),

    summary: async () => ({
      totalLoans: 1,
      onLoan: 1,
      overdue: 0,
      fineRub: 0,
      popularBooks: [],
      asOf: '2026-10-08',
    }),
  },
  { user: 'demo', password: 'demo' },
);

const get = (path) => request(app).get(path).auth('demo', 'demo');

for (const [method, path] of [
  ['get', '/api/me'],
  ['get', '/api/loans'],
  ['get', '/api/loans/1'],
  ['get', '/api/readers'],
  ['get', '/api/copies'],
  ['get', '/api/summary'],
  ['post', '/api/loans'],
  ['post', '/api/loans/1/return'],
])
  test(`${method} ${path}: без авторизации 401`, async () => {
    await request(app)[method](path).expect(401);
  });

test('Неверный пароль: 401', async () => {
  await request(app).get('/api/me').auth('demo', 'wrong').expect(401);
});

test('Профиль возвращает пользователя и префикс', async () => {
  const r = await get('/api/me').expect(200);

  assert.equal(r.body.username, 'demo');
  assert.equal(r.body.prefix, 'maksim_bataron');
});

test('Список: пагинация, поля и измерения', async () => {
  const r = await get('/api/loans?page=2&size=5&status=active').expect(200);

  assert.equal(r.body.page, 2);
  assert.equal(r.body.size, 5);
  assert.equal(r.body.items[0].id, 1);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['server-timing'], /queries/);
});

for (const params of [
  'page=0',
  'size=101',
  'status=bad',
  'page=1.5',
  'page[]=1',
  'q[]=a',
])
  test(`Неверные параметры ${params}: 422`, async () => {
    await get('/api/loans?' + params).expect(422);
  });

test('Карточка: связанные данные', async () => {
  const r = await get('/api/loans/1').expect(200);

  assert.equal(r.body.bookTitle, 'Книга');
  assert.equal(r.body.readerName, 'Читатель');
});

test('Отсутствующая карточка: 404', async () => {
  await get('/api/loans/2').expect(404);
});

test('Неверный идентификатор: 422', async () => {
  await get('/api/loans/abc').expect(422);
});

test('Читатели: список', async () => {
  const r = await get('/api/readers').expect(200);

  assert.equal(r.body.items[0].hasOverdue, false);
});

test('Экземпляры: список', async () => {
  const r = await get('/api/copies').expect(200);

  assert.ok(r.body.items[0].inventoryNumber);
});

test('Сводка: итоговые поля', async () => {
  const r = await get('/api/summary').expect(200);

  assert.equal(r.body.totalLoans, 1);
  assert.ok(Array.isArray(r.body.popularBooks));
});

test('Создание: 201 и Location', async () => {
  const r = await request(app)
    .post('/api/loans')
    .auth('demo', 'demo')
    .send({ readerId: 1, copyId: 2, dueDate: '2099-10-22' })
    .expect(201);

  assert.equal(r.headers.location, '/api/loans/1');
});

test('Создание с пустым телом: 422', async () => {
  await request(app)
    .post('/api/loans')
    .auth('demo', 'demo')
    .send({})
    .expect(422);
});

test('Создание с прошедшим сроком: 422', async () => {
  await request(app)
    .post('/api/loans')
    .auth('demo', 'demo')
    .send({ readerId: 1, copyId: 2, dueDate: '2020-01-01' })
    .expect(422);
});

test('Возврат: 200 и дата', async () => {
  const r = await request(app)
    .post('/api/loans/1/return')
    .auth('demo', 'demo')
    .expect(200);

  assert.ok(r.body.returnedAt);
});

test('Некорректный JSON: 400', async () => {
  await request(app)
    .post('/api/loans')
    .auth('demo', 'demo')
    .set('Content-Type', 'application/json')
    .send('{broken')
    .expect(400);
});

test('Неизвестный маршрут: 404', async () => {
  await get('/api/missing').expect(404);
});

test('Бизнес-конфликт передаётся клиенту как 409', async () => {
  const conflict = createApp(
    {
      issue: async () => {
        throw new AppError(409, 'COPY_BUSY', 'Занят');
      },
    },
    { user: 'demo', password: 'demo' },
  );

  const r = await request(conflict)
    .post('/api/loans')
    .auth('demo', 'demo')
    .send({ readerId: 1, copyId: 2, dueDate: '2099-10-22' })
    .expect(409);

  assert.equal(r.body.error.code, 'COPY_BUSY');
});
