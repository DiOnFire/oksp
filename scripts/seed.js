import { pool, transaction, prefix } from '../src/db.js';

const size = process.argv[2];

if (!['small', 'work'].includes(size) || !process.argv.includes('--yes'))
  throw new Error(
    'Usage: seed.js small|work --yes (replaces all library data)',
  );

const [readers, books, copies, loans, active] =
  size === 'small'
    ? [50, 100, 200, 300, 100]
    : [3000, 10000, 30000, 50000, 15000];

try {
  await transaction(async (sql) => {
    await sql('TRUNCATE loans,copies,books,readers RESTART IDENTITY');

    await sql(
      `INSERT INTO readers(id,name) SELECT i,'Читатель '||lpad(i::text,4,'0') FROM generate_series(1,$1::int) i`,
      [readers],
    );

    await sql(
      `INSERT INTO books(id,title,author) SELECT i,'Книга '||lpad(i::text,5,'0'),'Автор '||((i-1)%100+1) FROM generate_series(1,$1::int) i`,
      [books],
    );

    await sql(
      `INSERT INTO copies(id,book_id,inventory_number) SELECT i,(i-1)%$2::int+1,'INV-'||lpad(i::text,6,'0') FROM generate_series(1,$1::int) i`,
      [copies, books],
    );

    await sql(
      `INSERT INTO loans(id,reader_id,copy_id,issued_at,due_date,returned_at)
      SELECT i,(i-1)%$2::int+1,(i-1)%$3::int+1,
        DATE '2025-01-01'+((i-1)/$3::int)*45,
        DATE '2025-01-15'+((i-1)/$3::int)*45,
        DATE '2025-01-10'+((i-1)/$3::int)*45+(i%12)
      FROM generate_series(1,$1::int) i`,
      [loans - active, readers, copies],
    );

    await sql(
      `INSERT INTO loans(id,reader_id,copy_id,issued_at,due_date)
      SELECT $1::int+i,2+(i-1)%($3::int-1),i,DATE '2026-09-01',DATE '2026-10-01'+(i%30)
      FROM generate_series(1,$2::int) i`,
      [loans - active, active, readers],
    );

    for (const table of ['readers', 'books', 'copies', 'loans'])
      await sql(
        `SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT max(id) FROM ${table}))`,
      );
  });

  await pool.query('ANALYZE');

  const counts = {};

  for (const table of ['readers', 'books', 'copies', 'loans']) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count,md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) AS checksum FROM ${table} t`,
    );

    counts[table] = rows[0];
  }

  console.log(JSON.stringify({ prefix, size, counts }, null, 2));
} finally {
  await pool.end();
}
