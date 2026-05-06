# Javonon — Международные гранты на образование

Полнофункциональная платформа для агентства международных грантов:
- **Лендинг** (публичный сайт) с формой заявки
- **CRM-панель** для сотрудников (заявки, студенты, кабинеты, роли)
- **Backend API** на NestJS с PostgreSQL, JWT-авторизацией, загрузкой файлов и уведомлениями (in-app, Telegram, Email)

Платформа покрывает гранты по всему миру: 🇺🇸 США, 🇬🇧 Великобритания, 🇩🇪 Германия, 🇰🇷 Корея, 🇨🇳 Китай, 🇯🇵 Япония, 🇹🇷 Турция и другие страны.

## Стек технологий

| Часть | Технологии |
|---|---|
| Backend | NestJS · Prisma · PostgreSQL · JWT · Multer · Telegraf |
| Лендинг | React 18 · TypeScript · Vite · Framer Motion · PWA |
| CRM | React 18 · TypeScript · Vite · React Router · Zustand · Axios · Socket.IO |

## Структура

```
javonon/
├── backend/             # NestJS API + PostgreSQL (Prisma)
├── frontend-landing/    # Публичный сайт с формой заявки
├── frontend-crm/        # Админ-панель (/admin)
├── docker-compose.yml   # PostgreSQL для разработки
└── README.md
```

## Быстрый старт

### 1. Запустить PostgreSQL (через Docker)

```bash
docker compose up -d
```

PostgreSQL поднимется на `localhost:5432`, БД `javonon`, пользователь `javonon`, пароль `javonon`.

### 2. Backend

```bash
cd backend
cp .env.example .env             # отредактировать значения
npm install
npx prisma migrate dev --name init
npm run seed                     # создать админа admin@javonon.local / admin123
npm run seed:programs            # загрузить международные гранты
npm run start:dev
```

API стартует на `http://localhost:3001`.

### 3. Лендинг

```bash
cd frontend-landing
npm install
npm run dev
```

Лендинг откроется на `http://localhost:5173`.

### 4. CRM-панель

```bash
cd frontend-crm
npm install
npm run dev
```

CRM откроется на `http://localhost:5174/admin`.
Войти: **admin@javonon.local / admin123**.

## Логика автораспределения по кабинетам

| Направление | Кабинет |
|---|---|
| Бакалавриат (BACHELOR) | 1 |
| Магистратура (MASTER) | 2 |
| Языковые курсы (LANGUAGE) | 3 |
| Языковой + колледж | 4 |
| Языковой + бакалавриат | 5 |
| Колледж | 6 |

Кабинет можно переопределить вручную в карточке студента.

## Уведомления

При создании новой заявки система:
1. Сохраняет in-app уведомление для всех сотрудников/админов
2. Отправляет сообщение в Telegram-чат (если задан `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`)
3. Шлёт email админу (если настроены SMTP-параметры)
4. Отправляет SMS клиенту (если настроен SMS-провайдер)

Все каналы опциональны — без настроек просто пропускаются.

## Роли

- **ADMIN** — полный доступ, управление пользователями, программами, активностью
- **EMPLOYEE** — работа с заявками и студентами (только своими)
- **STUDENT** — личный кабинет, документы, анкета, каталог программ

## Деплой

См. [DEPLOY.md](./DEPLOY.md) — пошаговая инструкция для Vercel + Railway.

## Лицензия

MIT
