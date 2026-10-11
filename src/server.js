import { createApp } from './app.js';
import { repository } from './repository.js';
import { pool, prefix } from './db.js';
import { today, validDate } from './rules.js';

if (!validDate(today())) throw new Error('Invalid APP_TODAY');

await pool.query('SELECT 1 FROM loans LIMIT 1');

const port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '127.0.0.1';

const server = createApp(repository).listen(port, host, () =>
  console.log(`${prefix}: http://${host}:${port}, date=${today()}`),
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    }),
  );
