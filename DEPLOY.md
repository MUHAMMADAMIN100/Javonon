# 🚀 Javonon — Инструкция по деплою

Полный пошаговый деплой проекта **Javonon** на:
- **Backend + PostgreSQL** → Railway
- **Frontend Landing + CRM** → Vercel
- **Репозиторий** → GitHub (`MUHAMMADAMIN100/Javonon`)

---

## Шаг 1. GitHub

Если ещё не пушил репозиторий:

```bash
cd "C:\Users\Muhammadamin\Desktop\Grant Javonon\grant_china"
git init -b main
git add .
git commit -m "Initial commit: Javonon — international grants platform"
git remote add origin https://github.com/MUHAMMADAMIN100/Javonon.git
git push -u origin main
```

> Если репозитория ещё нет: создай его на [github.com/new](https://github.com/new) с именем `Javonon` (private или public — на твой выбор), без README/`.gitignore`/лицензии (они уже в проекте).

---

## Шаг 2. Railway — Backend + PostgreSQL

### 2.1. Создаём PostgreSQL

1. Зайди на [railway.app](https://railway.app) → **New Project**
2. Выбери **Provision PostgreSQL**
3. Готово — Railway создаст переменную `DATABASE_URL` автоматически

### 2.2. Деплоим Backend

1. В этом же проекте → **New Service** → **GitHub Repo** → выбери `MUHAMMADAMIN100/Javonon`
2. **Settings → Root Directory:** `backend`
3. **Settings → Build:** Railway автоматически использует `nixpacks` (через `railway.json`)
4. **Variables** → добавь:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
PORT=3001
JWT_SECRET=<сгенерируй длинную случайную строку, минимум 64 символа>
STUDENT_JWT_SECRET=<другая длинная случайная строка>
CORS_ORIGINS=https://javonon.vercel.app,https://javonon-crm.vercel.app
UPLOADS_DIR=./uploads
MAX_FILE_SIZE=52428800
SEED_IF_EMPTY=1
```

> **Совет:** для генерации секретов — `openssl rand -hex 32` или [randomkeygen.com](https://randomkeygen.com/).

> **JWT TTL:** переменная `JWT_EXPIRES_IN` раньше была одной ручкой на все три аудитории и перекрывала код-дефолты. Теперь её быть не должно — **удали `JWT_EXPIRES_IN` из Railway Variables**, если она там осталась. Дефолты в коде: `staff → 30d`, `student → 7d`, `partner → 30d`. Чтобы явно переопределить — задай `STAFF_JWT_EXPIRES_IN`, `STUDENT_JWT_EXPIRES_IN` или `PARTNER_JWT_EXPIRES_IN` по-отдельности.

5. **Settings → Networking → Generate Domain** → получишь URL вида `javonon-production.up.railway.app`
6. Запиши этот URL — он понадобится для фронтов

### 2.3. Проверь, что бекенд запустился

Открой `https://javonon-production.up.railway.app/api/programs/public` — должен вернуть JSON со списком грантов.

### 2.4. Создание админа

Backend при старте автоматически запустит seed программ (т.к. `SEED_IF_EMPTY=1`).
Чтобы создать админа, в **Railway → Service → Console** выполни:

```bash
npm run seed
```

После этого логин админа: **admin@javonon.local** / **admin123**.

---

## Шаг 3. Vercel — Landing

1. Зайди на [vercel.com](https://vercel.com) → **Add New Project** → импортируй `MUHAMMADAMIN100/Javonon`
2. **Project Name:** `javonon` (или `javonon-landing`)
3. **Framework Preset:** Vite
4. **Root Directory:** `frontend-landing`
5. **Build Command:** `npm run build` (по умолчанию)
6. **Output Directory:** `dist` (по умолчанию)
7. **Environment Variables:**

```env
VITE_API_URL=https://javonon-production.up.railway.app/api
```

> Замени URL на реальный URL твоего бекенда из Railway

8. **Deploy** → через 1-2 минуты получишь `https://javonon.vercel.app`

---

## Шаг 4. Vercel — CRM

1. **Add New Project** → снова тот же репозиторий `MUHAMMADAMIN100/Javonon`
2. **Project Name:** `javonon-crm`
3. **Framework Preset:** Vite
4. **Root Directory:** `frontend-crm`
5. **Environment Variables:**

```env
VITE_API_URL=https://javonon-production.up.railway.app/api
```

6. **Deploy** → получишь `https://javonon-crm.vercel.app`
7. Открой `https://javonon-crm.vercel.app/admin/login` — войди как `admin@javonon.local` / `admin123`

---

## Шаг 5. Связывание лендинга и CRM

В файле [frontend-landing/vercel.json](./frontend-landing/vercel.json) уже прописано проксирование `/admin` на CRM-домен:

```json
{ "source": "/admin", "destination": "https://javonon-crm.vercel.app/admin" },
{ "source": "/admin/(.*)", "destination": "https://javonon-crm.vercel.app/admin/$1" }
```

Это значит, что после деплоя `https://javonon.vercel.app/admin` будет показывать CRM из второго проекта.

> Если ты дал лендингу другое имя (не `javonon-crm.vercel.app`) — обнови URL в `frontend-landing/vercel.json` и сделай новый коммит.

---

## Шаг 6. Обновление CORS на бекенде

После того как Vercel выдаст финальные URL, обнови `CORS_ORIGINS` в Railway:

```env
CORS_ORIGINS=https://javonon.vercel.app,https://javonon-crm.vercel.app
```

Если используешь preview-деплои Vercel (`*.vercel.app`) — они уже разрешены wildcard'ом в [main.ts](./backend/src/main.ts).

После сохранения переменных Railway автоматически перезапустит сервис.

---

## 🧪 Проверка работоспособности

| URL | Что должно открыться |
|---|---|
| `https://javonon.vercel.app` | Главная страница лендинга (зелёный дизайн, форма заявки) |
| `https://javonon.vercel.app/login` | Вход для студентов |
| `https://javonon.vercel.app/admin` | Логин CRM (через прокси) |
| `https://javonon-crm.vercel.app/admin` | Логин CRM (прямой URL) |
| `https://javonon-production.up.railway.app/api/programs/public` | JSON списка грантов |

### Smoke test:
1. Открой лендинг → отправь заявку через форму
2. Зайди в CRM как админ → убедись, что заявка появилась в списке
3. Проверь Realtime — открой CRM в двух вкладках, обнови заявку в одной — обновится во второй

---

## 🐛 Решение типовых проблем

### CORS-ошибка во фронте
- Проверь, что `CORS_ORIGINS` на Railway содержит точный URL фронта (с `https://`, без слэша в конце)
- Перезапусти Railway-сервис после изменения переменных

### "Failed to fetch /api/..."
- Проверь, что `VITE_API_URL` на Vercel содержит **/api** в конце
- Убедись, что бекенд жив: `curl https://<your-railway>.up.railway.app/api/programs/public`

### Логин в CRM не работает
- Зайди в Railway → Service → Console → выполни `npm run seed`
- Если "пользователь не найден" — `npm run reset:admin` создаст пароль заново

### "404 на /admin"
- Проверь `vercel.json` лендинга и URL CRM в `rewrites`
- Убедись, что CRM-проект задеплоен и доступен по своему адресу

---

## 🔁 Как обновить продакшен после изменений

```bash
git add .
git commit -m "describe what changed"
git push
```

Vercel и Railway автоматически подхватят изменения и пересоберут проекты.

---

## ⚠️ Схема БД: только «вперёд», без откатов

У проекта **нет** папки `backend/prisma/migrations` — то есть нет истории миграций
и нет down-миграций, которые можно было бы проиграть назад. На каждом старте
контейнера `start:prod` выполняет `prisma db push`, а он приводит живую БД к тому
виду, который описан в `schema.prisma` **из этого образа**.

Отсюда главное правило: **откат кода = откат схемы = потеря данных.**
Если задеплоить коммит, где в `schema.prisma` нет какой-то колонки, `db push`
сгенерирует для неё `DROP COLUMN`, и всё, что клиенты успели туда записать между
деплоем и откатом, исчезнет безвозвратно.

### Что защищает

Из `start:prod` намеренно убран флаг `--accept-data-loss`. Он подавлял ровно то
подтверждение, которое должно останавливать такие удаления. Теперь при
деструктивном диффе `db push` завершается с ошибкой, цепочка `&&` обрывается,
`node dist/main` не стартует, и Railway помечает деплой упавшим
(`restartPolicyType: ON_FAILURE`, 3 попытки).

Это осознанный размен: **шумный и обратимый отказ деплоя вместо тихой и
необратимой потери данных.** Аддитивные изменения (новые nullable-колонки, новые
enum'ы, новые индексы) проходят как раньше — без флага и без запроса.

### Если деплой упал на `db push`

Значит Prisma собралась что-то удалить. Не «чинить» это возвратом флага в
`start:prod`. Сначала разобраться, что именно и почему:

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
```

Если удаление действительно задумано — сначала снять дамп, потом применить
удаление вручную и осознанно:

```bash
npm run db:push:force   # тот же db push, но с --accept-data-loss
```

### Перед рискованным деплоем

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F-%H%M).sql
```

И проверить, что в Railway включены автоматические бэкапы Postgres.

### Если откат всё-таки неизбежен

Сначала вынести данные в таблицу, которой нет в `schema.prisma` — `db push` её
не тронет, потому что не знает о ней:

```sql
CREATE TABLE "_application_new_cols_backup" AS
SELECT id, country::text AS country, "whatsappPhone", birthday
FROM "Application"
WHERE country IS NOT NULL OR "whatsappPhone" IS NOT NULL OR birthday IS NOT NULL;
```

> ⚠️ Откат через кнопку Railway «redeploy previous deployment» этой защитой **не
> покрывается**: там поднимается старый образ со старым `package.json`, где флаг
> `--accept-data-loss` ещё был. Откатываться нужно через `git revert` + новый
> деплой, тогда сборка идёт с текущим `package.json` и защита сработает.

---

## Перевод статусов заявок на набор квалификации лида

Отдельный раздел, потому что здесь легко уронить прод, действуя «как обычно».

### Почему это не обычная миграция

`start:prod` — это цепочка `&&`, и `node dist/main` стоит в ней **последним**.
Значит все `prisma`-скрипты доигрывают **до** того, как новый процесс займёт
порт. Railway всё это время продолжает отдавать трафик **предыдущему**
контейнеру.

Предыдущий контейнер собран со старым Prisma-клиентом: в его сгенерённом enum'е
есть только `NEW`, `IN_PROGRESS`, `COMPLETED`, `DOCS_REVIEW`, `DOCS_SUBMITTED`,
`PRE_ADMISSION`, `AWAITING_PAYMENT`, `ENROLLED`. Prisma **бросает исключение**,
если читает из БД значение enum'а, которого нет в клиенте. Поэтому перевод
~496 строк в `NEW_LEAD` / `IN_PROCESSING` / `SUCCESSFUL_LEAD` прямо на старте
означает 500 на всём, что читает `Application.status`, пока новый контейнер не
пройдёт healthcheck:

- `GET /applications`, `GET /applications/stats`
- `GET /students` (в include тянутся заявки)
- `GET /kpi/leaderboard`
- `me` в кабинете студента (student-auth)

То есть вся CRM и весь кабинет разом.

> Компат-списки в `backend/src/common/application-status.ts` от этого **не
> спасают**: они есть только в новом коде, а падает старый.

### Как это защищено

Перенос строк — **опт-ин**. Без переменной `MIGRATE_LEAD_STATUSES` не делают
ничего ни `prisma/migrate-lead-statuses.ts`, ни страховочный хук
`PrismaService.migrateLegacyStatuses()` (он висит на `onModuleInit`, то есть
тоже отрабатывает до `app.listen()`).

Флаг **не** влияет на `prisma db push`: добавление значений в enum аддитивно,
старому читателю оно безразлично и должно проходить на каждом деплое.

Читать легаси-строки новый код умеет и без переноса, поэтому откладывать его
безопасно — данные просто остаются неприбранными.

### Порядок раскатки (два деплоя)

**Деплой N — код.** Выкатываем как обычно, `MIGRATE_LEAD_STATUSES` **не
трогаем**. `db push` добавит значения в enum, строки останутся на легаси-
статусах, старый контейнер спокойно дочитает своё и уйдёт.

Убедиться, что новый код действительно везде:

```bash
railway logs | grep "Lead status migration skipped"
```

**Деплой N+1 — данные.** Только после того, как деплой N отработал и стал
текущим:

1. Снять дамп: `pg_dump "$DATABASE_URL" > backup-$(date +%F-%H%M).sql`
2. Railway → Variables → добавить `MIGRATE_LEAD_STATUSES=1`
3. Дождаться рестарта и проверить лог:

```bash
railway logs | grep "Lead status migration"
```

Ожидаем `✅ Lead status migration complete: перенесено N строк.`
Если видим `⚠️  Lead status migration ЧАСТИЧНАЯ` — часть бакетов не прошла,
легаси-строки остались; разобраться по строкам с `!` выше и повторить.

4. **Убрать `MIGRATE_LEAD_STATUSES` из Variables.** Флаг одноразовый: пока он
   висит, любой рестарт снова гоняет перенос до `app.listen()`, и мы возвращаем
   себе ту же мину на будущее (например, когда легаси-значения начнут удалять
   из enum'а).

Почему N+1 безопасен: предыдущий контейнер — это уже код деплоя N, а он читает
и легаси-значения, и новые.

### Проверить, что перенос действительно завершён

```sql
SELECT status, count(*) FROM "Application" GROUP BY status ORDER BY 2 DESC;
```

Пока в выдаче есть хоть одно легаси-значение — **нельзя** ни чистить
легаси-хвосты из `FINISHED_APPLICATION_STATUSES` и соседних констант
(`backend/src/common/application-status.ts`, `frontend-crm/src/api/types.ts`,
`frontend-landing/src/applicationStatus.ts`), ни удалять значения из
`enum ApplicationStatus`.

Удаление значений из enum'а — это, кстати, зеркально та же проблема: новый
клиент не сможет прочитать строку, которая ещё лежит на удалённом значении.
Так что и оно идёт отдельным деплоем, после того как выдача выше стала чистой.

### Ручной прогон (локально / вне деплоя)

```bash
cd backend
npm run migrate:lead-statuses   # внутри уже стоит --force
```

`--force` — аргумент, а не `VAR=1 cmd`: последнее не работает в PowerShell.

---

### На перспективу

Связку стоит перевести с `db push` на нормальные миграции (`prisma migrate deploy`).
Просто заменить команду нельзя: сейчас папки `migrations` нет, поэтому
`migrate deploy` не применит ничего, колонки не создадутся и приложение упадёт на
первом же запросе. Нужен baseline существующей боевой БД через
`prisma migrate resolve --applied`.

---

## 📞 Опционально: подключить домен `javonon.com`

1. Купи домен (Namecheap, Cloudflare Registrar и т.д.)
2. **Vercel → javonon project → Settings → Domains → Add `javonon.com`**
3. Добавь A/CNAME-запись в DNS-провайдере по инструкции Vercel
4. Точно так же для CRM, если хочешь поддомен `crm.javonon.com`
5. Обнови `CORS_ORIGINS` на Railway, добавив новые домены

После подключения домена backend уже разрешает wildcard `*.javonon.com` (см. [main.ts](./backend/src/main.ts)) — отдельных правок не надо.
