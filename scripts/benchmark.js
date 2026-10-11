import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { pool, prefix } from '../src/db.js';
import { today } from '../src/rules.js';

const size = process.argv[2],
  repetitions = 30,
  warmup = 5;

if (!['small', 'work'].includes(size))
  throw new Error('Usage: npm run benchmark -- small|work');

const base =
  process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

const authorization =
  'Basic ' +
  Buffer.from(`${process.env.AUTH_USER}:${process.env.AUTH_PASSWORD}`).toString(
    'base64',
  );

const samples = {};

async function request(method, path, body) {
  const start = performance.now();

  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const elapsed = performance.now() - start;
  const data = JSON.parse(raw);

  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${raw}`);

  const timing = response.headers.get('server-timing') || '';
  const number = (key) =>
    Number(timing.match(new RegExp(`${key};dur=([\\d.]+)`))?.[1] || 0);

  return {
    data,
    ms: elapsed,
    serverMs: number('total'),
    dbMs: number('db'),
    appMs: number('app'),
    queries: Number(timing.match(/queries;desc="(\d+)"/)?.[1] || 0),
  };
}

async function measure(name, method, path, body, record) {
  const result = await request(method, path, body);

  if (record) {
    const { data, ...timings } = result;

    (samples[name] ||= []).push(timings);
  }

  return result.data;
}

const quantile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

try {
  const counts = {};

  for (const table of ['readers', 'books', 'copies', 'loans'])
    counts[table] = (
      await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
    ).rows[0].n;

  const expected = size === 'small' ? 300 : 50000;

  if (counts.loans !== expected)
    throw new Error(
      `Fresh ${size} seed required: expected ${expected} loans, got ${counts.loans}`,
    );

  const copyId = size === 'small' ? 200 : 30000;

  const operations = [
    ['Профиль', '/api/me'],
    ['Список выдач', '/api/loans?page=1&size=20&status=active&q=Книга'],
    ['Карточка выдачи', '/api/loans/1'],
    ['Читатели', '/api/readers?q=Читатель'],
    ['Свободные экземпляры', '/api/copies?q=Книга'],
    ['Сводка', '/api/summary'],
  ];

  for (const [name, path] of operations)
    for (let i = 0; i < warmup + repetitions; i++)
      await measure(name, 'GET', path, null, i >= warmup);

  for (let i = 0; i < warmup + repetitions; i++) {
    const loan = await measure(
      'Выдача',
      'POST',
      '/api/loans',
      { readerId: 1, copyId, dueDate: today() },
      i >= warmup,
    );

    await measure(
      'Возврат',
      'POST',
      `/api/loans/${loan.id}/return`,
      null,
      i >= warmup,
    );
  }

  const stats = {};

  for (const [name, rows] of Object.entries(samples)) {
    const metric = (field) => rows.map((r) => r[field]);

    stats[name] = {
      p50: quantile(metric('ms'), 0.5),
      p95: quantile(metric('ms'), 0.95),
      max: Math.max(...metric('ms')),
      serverMean: metric('serverMs').reduce((a, b) => a + b) / rows.length,
      dbMean: metric('dbMs').reduce((a, b) => a + b) / rows.length,
      appMean: metric('appMs').reduce((a, b) => a + b) / rows.length,
      queries: metric('queries').reduce((a, b) => a + b) / rows.length,
    };
  }

  const metadata = {
    prefix,
    size,
    date: new Date().toISOString(),
    logicalDate: today(),
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memoryGiB: os.totalmem() / 1024 ** 3,
    postgres: (await pool.query('SELECT version()')).rows[0].version,
    account: process.env.AUTH_USER,
    repetitions,
    warmup,
    concurrency: 1,
    counts,
    addedLoans: warmup + repetitions,
  };

  await mkdir('results', { recursive: true });

  await writeFile(
    `results/${size}.json`,
    JSON.stringify({ metadata, stats, samples }, null, 2) + '\n',
  );

  console.log(JSON.stringify({ metadata, stats }, null, 2));
} finally {
  await pool.end();
}
