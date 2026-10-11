import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { metrics, prefix } from './db.js';
import { AppError, positiveInt, today, validDate } from './rules.js';

const equal = (a, b) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);

  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

export function createApp(
  repository,
  auth = { user: process.env.AUTH_USER, password: process.env.AUTH_PASSWORD },
) {
  if (!auth.user || !auth.password)
    throw new Error('Set AUTH_USER and AUTH_PASSWORD');

  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');

    res.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );

    next();
  });

  app.use('/api', (req, res, next) =>
    metrics.run({ dbMs: 0, queries: 0 }, () => {
      const start = performance.now();

      res.json = (body) => {
        const encoded = JSON.stringify(body),
          m = metrics.getStore(),
          total = performance.now() - start;

        res.set(
          'Server-Timing',
          `total;dur=${total.toFixed(3)}, db;dur=${m.dbMs.toFixed(3)}, app;dur=${Math.max(0, total - m.dbMs).toFixed(3)}, queries;desc="${m.queries}"`,
        );

        return res.type('json').send(encoded);
      };

      next();
    }),
  );

  app.use('/api', (req, res, next) => {
    const header = req.get('authorization') || '';
    const decoded = header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString()
      : '';

    if (!equal(decoded, `${auth.user}:${auth.password}`))
      return next(new AppError(401, 'UNAUTHORIZED', 'Требуется вход'));

    next();
  });

  app.use('/api', (req, res, next) => {
    if (
      Object.entries(req.query).some(
        ([key, value]) => /[\[\]]/.test(key) || typeof value !== 'string',
      )
    )
      return next(
        new AppError(
          422,
          'VALIDATION_ERROR',
          'Параметры запроса должны быть одиночными строками',
        ),
      );

    next();
  });

  app.use(express.json({ limit: '16kb' }));

  app.get('/api/me', (req, res) =>
    res.json({
      username: auth.user,
      prefix,
      today: today(),
      finePerDayRub: 10,
    }),
  );

  const search = (value) => {
    if (value === undefined) return '';

    if (typeof value !== 'string' || value.length > 100)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Поиск: не более 100 символов',
      );

    return value.trim();
  };

  app.get('/api/loans', async (req, res) => {
    const page = positiveInt(req.query.page ?? 1, 'page', 1000000),
      size = positiveInt(req.query.size ?? 20, 'size', 100);
    const status = req.query.status ?? '';

    if (!['', 'active', 'overdue', 'returned'].includes(status))
      throw new AppError(422, 'VALIDATION_ERROR', 'Неизвестный статус');

    res.json(
      await repository.list({
        page,
        size,
        status,
        q: search(req.query.q),
      }),
    );
  });

  app.get('/api/loans/:id', async (req, res) =>
    res.json(await repository.detail(positiveInt(req.params.id, 'id'))),
  );
  app.get('/api/readers', async (req, res) =>
    res.json(await repository.readers(search(req.query.q))),
  );
  app.get('/api/copies', async (req, res) =>
    res.json(await repository.copies(search(req.query.q))),
  );
  app.get('/api/summary', async (req, res) =>
    res.json(await repository.summary()),
  );

  app.post('/api/loans', async (req, res) => {
    const { readerId, copyId, dueDate } = req.body || {};
    const reader = positiveInt(readerId, 'readerId'),
      copy = positiveInt(copyId, 'copyId');

    if (!validDate(dueDate) || dueDate < today())
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Срок возврата должен быть не раньше текущей даты',
      );

    const loan = await repository.issue({
      readerId: reader,
      copyId: copy,
      dueDate,
    });

    res.status(201).location(`/api/loans/${loan.id}`).json(loan);
  });

  app.post('/api/loans/:id/return', async (req, res) =>
    res.json(await repository.returnLoan(positiveInt(req.params.id, 'id'))),
  );
  app.use('/api', (req, res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'Операция не найдена')),
  );

  app.use(
    express.static(fileURLToPath(new URL('../public', import.meta.url)), {
      etag: false,
      lastModified: false,
      maxAge: 0,
    }),
  );

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    const status = error.status || 500;

    if (status >= 500) console.error(error);

    res.status(status).json({
      error: {
        code:
          error.code ||
          (status === 400
            ? 'INVALID_JSON'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : 'INTERNAL_ERROR'),
        message: status >= 500 ? 'Внутренняя ошибка сервера' : error.message,
      },
    });
  });

  return app;
}
