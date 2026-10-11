let credentials = '',
  page = 1,
  selectedLoan = null,
  serverDate = '';

const $ = (selector) => document.querySelector(selector);

const labels = {
  active: 'На руках',
  overdue: 'Просрочена',
  returned: 'Возвращена',
};

const text = (tag, value, className) => {
  const node = document.createElement(tag);

  node.textContent = value;

  if (className) node.className = className;

  return node;
};

function notify(value = '') {
  $('#message').textContent = value;
}

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    cache: 'no-store',
    headers: { Authorization: credentials, 'Content-Type': 'application/json' },
  });

  const data = await response.json();

  if (!response.ok) throw new Error(data.error.message);

  return data;
}

function action(fn) {
  return async (event) => {
    event?.preventDefault();
    notify();

    try {
      await fn(event);
    } catch (error) {
      notify(error.message);
    }
  };
}

function screen(name) {
  for (const section of document.querySelectorAll('#workspace > section'))
    section.hidden = section.id !== `${name}-screen`;
}

async function list() {
  const params = new URLSearchParams(new FormData($('#filters')));

  params.set('page', page);
  params.set('size', 20);

  const data = await api('/loans?' + params);
  const body = $('#loans-body');

  body.replaceChildren();

  for (const loan of data.items) {
    const row = document.createElement('tr');

    for (const value of [
      loan.id,
      loan.bookTitle,
      loan.readerName,
      loan.dueDate,
    ])
      row.append(text('td', value));

    const status = document.createElement('td');

    status.append(text('span', labels[loan.status], 'tag ' + loan.status));
    row.append(status);

    const cell = document.createElement('td'),
      button = text('button', 'Открыть');

    button.onclick = action(() => detail(loan.id));
    cell.append(button);
    row.append(cell);
    body.append(row);
  }

  if (!data.items.length) {
    const row = document.createElement('tr'),
      cell = text('td', 'Выдач не найдено');

    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }

  $('#total').textContent = `Всего: ${data.total}`;
  $('#page').textContent =
    `Страница ${page} из ${Math.max(1, Math.ceil(data.total / 20))}`;
  $('#prev').disabled = page === 1;
  $('#next').disabled = page * 20 >= data.total;
  screen('loans');
}

async function detail(id) {
  const loan = await api('/loans/' + id);

  selectedLoan = loan.id;

  const dl = document.createElement('dl');

  for (const [key, value] of Object.entries({
    'Номер выдачи': loan.id,
    Книга: loan.bookTitle,
    Автор: loan.author,
    Экземпляр: loan.inventoryNumber,
    Читатель: loan.readerName,
    'Дата выдачи': loan.issuedAt,
    'Вернуть до': loan.dueDate,
    'Дата возврата': loan.returnedAt || 'Ещё не возвращена',
    Статус: labels[loan.status],
    Просрочка: loan.overdueDays + ' дн.',
    Штраф: loan.fineRub + ' ₽',
  }))
    dl.append(text('dt', key), text('dd', value));

  $('#detail').replaceChildren(dl);
  $('#return').hidden = Boolean(loan.returnedAt);
  screen('detail');
}

async function choices(kind, q = '') {
  const data = await api('/' + kind + '?q=' + encodeURIComponent(q)),
    select = $('#' + kind);

  select.replaceChildren();

  for (const item of data.items) {
    const option = text(
      'option',
      kind === 'readers'
        ? `${item.name}${item.hasOverdue ? ' — есть просрочка' : ''}`
        : `${item.inventoryNumber} · ${item.title}`,
    );

    option.value = item.id;
    select.append(option);
  }

  if (!data.items.length) {
    const option = text('option', 'Совпадений нет');

    option.value = '';
    select.append(option);
  }
}

async function summary() {
  const data = await api('/summary');

  $('#stats').replaceChildren();

  for (const [label, value] of [
    ['Всего выдач', data.totalLoans],
    ['На руках', data.onLoan],
    ['Просрочено', data.overdue],
    ['Штрафы, ₽', data.fineRub],
  ]) {
    const item = text('div', label, 'stat');

    item.append(text('strong', value.toLocaleString('ru-RU')));
    $('#stats').append(item);
  }

  $('#popular').replaceChildren(
    ...data.popularBooks.map((book) =>
      text('li', `${book.title} — ${book.loanCount} выдач`),
    ),
  );

  screen('summary');
}

$('#login-form').onsubmit = action(async () => {
  const form = new FormData($('#login-form'));

  credentials =
    'Basic ' +
    btoa(
      unescape(
        encodeURIComponent(form.get('username') + ':' + form.get('password')),
      ),
    );

  const me = await api('/me');

  serverDate = me.today;
  $('#identity').textContent =
    `${me.prefix} · ${me.username} · Дата стенда: ${me.today}`;
  $('#login-panel').hidden = true;
  $('#workspace').hidden = false;
  $('#logout').hidden = false;
  $('#due-date').min = serverDate;
  $('#due-date').value = new Date(Date.parse(serverDate) + 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  $('#login-form').reset();

  await list();
});

$('#logout').onclick = () => {
  credentials = '';
  location.reload();
};

$('#filters').onsubmit = action(async () => {
  page = 1;

  await list();
});

$('#prev').onclick = action(async () => {
  page--;

  await list();
});

$('#next').onclick = action(async () => {
  page++;

  await list();
});

$('#back').onclick = action(list);

$('#return').onclick = action(async () => {
  const button = $('#return');

  button.disabled = true;

  try {
    await api(`/loans/${selectedLoan}/return`, { method: 'POST' });

    await detail(selectedLoan);
    notify('Возврат зарегистрирован');
  } finally {
    button.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-screen]'))
  button.onclick = action(async () => {
    const target = button.dataset.screen;

    if (target === 'loans') await list();
    else if (target === 'summary') await summary();
    else {
      await choices('readers');

      await choices('copies');
      screen('issue');
    }
  });

$('#reader-search').onsubmit = action(() =>
  choices('readers', new FormData($('#reader-search')).get('q')),
);

$('#copy-search').onsubmit = action(() =>
  choices('copies', new FormData($('#copy-search')).get('q')),
);

$('#issue-form').onsubmit = action(async () => {
  const button = $('#issue-form button');

  button.disabled = true;

  try {
    const form = Object.fromEntries(new FormData($('#issue-form')));

    form.readerId = Number(form.readerId);
    form.copyId = Number(form.copyId);

    const loan = await api('/loans', {
      method: 'POST',
      body: JSON.stringify(form),
    });

    await detail(loan.id);
    notify('Экземпляр выдан');
  } finally {
    button.disabled = false;
  }
});

$('#refresh-summary').onclick = action(summary);
