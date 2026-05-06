import { PrismaClient, Direction, Program } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Telegraf } from 'telegraf';

const prisma = new PrismaClient();

const DIRECTION_LABEL: Record<Direction, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

function escMd(s: string): string {
  return s.replace(/([_*[\]`])/g, '\\$1');
}

async function postToChannel(program: Program): Promise<{ messageId: number; hasPhoto: boolean } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channelId) {
    console.log('  (TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID не заданы — пропускаем пост в канал)');
    return null;
  }

  const caption =
    `🎓 *Новая программа на Javonon*\n\n` +
    `📚 *${escMd(program.name)}*\n` +
    `🏛 ${escMd(program.university)}\n` +
    `📍 ${escMd(program.city)}\n` +
    `🎯 ${escMd(program.major)} · ${DIRECTION_LABEL[program.direction]}\n` +
    (program.duration ? `⏱ ${escMd(program.duration)}\n` : '') +
    (program.language ? `🌐 ${escMd(program.language)}\n` : '') +
    `\n💰 Стоимость: *${program.cost.toLocaleString('ru-RU')} ${program.currency}* / год\n` +
    (program.description ? `\n${escMd(program.description.slice(0, 600))}` : '');

  const publicBase = process.env.PUBLIC_API_BASE;
  const photoUrl = program.imageUrl
    ? program.imageUrl.startsWith('http')
      ? program.imageUrl
      : publicBase
        ? `${publicBase}${program.imageUrl}`
        : null
    : null;

  const bot = new Telegraf(token);
  try {
    if (photoUrl) {
      const res = await bot.telegram.sendPhoto(channelId, photoUrl, {
        caption,
        parse_mode: 'Markdown',
      });
      console.log(`  📡 Пост в Telegram-канал отправлен (с фото, msg ${res.message_id})`);
      return { messageId: res.message_id, hasPhoto: true };
    } else {
      const res = await bot.telegram.sendMessage(channelId, caption, { parse_mode: 'Markdown' });
      console.log(`  📡 Пост в Telegram-канал отправлен (текст, msg ${res.message_id})`);
      return { messageId: res.message_id, hasPhoto: false };
    }
  } catch (e: any) {
    console.log(`  ⚠️  Не удалось отправить в канал: ${e?.message || e}`);
    return null;
  }
}

type SeedProgram = {
  name: string;
  university: string;
  city: string;
  major: string;
  direction: Direction;
  cost: number;
  currency: string;
  duration: string;
  language: string;
  description: string;
  imageFile?: string;
};

// Международные программы Javonon — гранты по всему миру.
const PROGRAMS: SeedProgram[] = [
  {
    name: 'Chinese Government Scholarship — Tsinghua University',
    university: 'Tsinghua University',
    city: 'Пекин, Китай',
    major: 'Computer Science · Engineering · Business',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '2–3 года',
    language: 'Английский / Китайский',
    description:
      '🇨🇳 Полный грант от правительства Китая (CSC) в один из лучших университетов Азии.\n\n' +
      '✅ Покрывается:\n' +
      '• 100% стоимость обучения\n' +
      '• Проживание в кампусе\n' +
      '• Медицинская страховка\n' +
      '• Ежемесячная стипендия 3000 ¥\n\n' +
      '📌 Требования:\n' +
      '• Возраст до 35 лет\n' +
      '• Диплом бакалавра (для магистратуры)\n' +
      '• IELTS 6.5+ или HSK 5\n' +
      '• Мотивационное письмо + 2 рекомендации\n\n' +
      '📅 Дедлайн: апрель ежегодно',
    imageFile: '1',
  },
  {
    name: 'Fulbright Scholarship Program',
    university: 'Top US Universities',
    city: 'США (различные штаты)',
    major: 'Любые направления магистратуры и PhD',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '1–2 года',
    language: 'Английский',
    description:
      '🇺🇸 Самый престижный американский грант для обучения в США.\n\n' +
      '✅ Покрывается:\n' +
      '• Полная стоимость обучения\n' +
      '• Авиабилеты в обе стороны\n' +
      '• Ежемесячная стипендия на проживание\n' +
      '• Медицинская страховка\n' +
      '• Расходы на учебные материалы\n\n' +
      '📌 Требования:\n' +
      '• Степень бакалавра с GPA 3.5+\n' +
      '• TOEFL 90+ или IELTS 7.0+\n' +
      '• GRE/GMAT (для некоторых программ)\n' +
      '• Сильное эссе и опыт работы\n\n' +
      '📅 Дедлайн: май–июнь',
    imageFile: '2',
  },
  {
    name: 'DAAD Stipendium — German Universities',
    university: 'TU Munich · Heidelberg · Berlin',
    city: 'Германия',
    major: 'Engineering · Sciences · Humanities',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'EUR',
    duration: '1–2 года',
    language: 'Английский / Немецкий',
    description:
      '🇩🇪 Германская служба академических обменов (DAAD) — крупнейшая стипендиальная программа Европы.\n\n' +
      '✅ Покрывается:\n' +
      '• Бесплатное обучение в государственных университетах\n' +
      '• Ежемесячная стипендия 934 €\n' +
      '• Медицинская страховка\n' +
      '• Travel allowance\n' +
      '• Курсы немецкого языка перед началом учёбы\n\n' +
      '📌 Требования:\n' +
      '• Диплом бакалавра (хорошие оценки)\n' +
      '• IELTS 6.5+ или TestDaF 4\n' +
      '• Опыт работы 2+ года\n' +
      '• Research proposal\n\n' +
      '📅 Дедлайн: октябрь',
    imageFile: '3',
  },
  {
    name: 'Global Korea Scholarship (GKS)',
    university: 'Seoul National University · KAIST',
    city: 'Сеул, Южная Корея',
    major: 'IT · Engineering · Korean Studies',
    direction: Direction.BACHELOR,
    cost: 0,
    currency: 'USD',
    duration: '4 + 1 года',
    language: 'Корейский / Английский',
    description:
      '🇰🇷 Самая крупная корейская стипендия для иностранных студентов.\n\n' +
      '✅ Покрывается:\n' +
      '• 100% стоимость обучения\n' +
      '• Год языковой подготовки бесплатно\n' +
      '• Ежемесячная стипендия 900 000 ₩\n' +
      '• Авиабилет туда-обратно\n' +
      '• Медстраховка + расходы на устройство\n\n' +
      '📌 Требования:\n' +
      '• Возраст до 25 лет\n' +
      '• Аттестат с GPA 80%+\n' +
      '• TOPIK 3+ или IELTS 5.5+\n' +
      '• Финальное собеседование\n\n' +
      '📅 Дедлайн: сентябрь',
    imageFile: '4',
  },
  {
    name: 'Türkiye Bursları (Turkey Scholarships)',
    university: 'Istanbul · Ankara · Izmir',
    city: 'Турция',
    major: 'Все направления',
    direction: Direction.BACHELOR,
    cost: 0,
    currency: 'USD',
    duration: '4 года',
    language: 'Турецкий / Английский',
    description:
      '🇹🇷 Полный государственный грант Турции для иностранных студентов.\n\n' +
      '✅ Покрывается:\n' +
      '• Полная стоимость обучения\n' +
      '• Бесплатное проживание в общежитии\n' +
      '• Ежемесячная стипендия 3500 ₺\n' +
      '• Год турецкого языка\n' +
      '• Медицинская страховка\n' +
      '• Авиабилеты\n\n' +
      '📌 Требования:\n' +
      '• Аттестат с оценками 70%+\n' +
      '• Возраст до 21 года (бакалавриат)\n' +
      '• Знание языка не обязательно (год подготовки)\n\n' +
      '📅 Дедлайн: февраль',
    imageFile: '5',
  },
  {
    name: 'MEXT Japanese Government Scholarship',
    university: 'University of Tokyo · Kyoto · Osaka',
    city: 'Япония',
    major: 'Sciences · Engineering · Japanese Studies',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '2 года',
    language: 'Японский / Английский',
    description:
      '🇯🇵 Грант от Министерства образования Японии (MEXT).\n\n' +
      '✅ Покрывается:\n' +
      '• Полное обучение\n' +
      '• Авиабилеты\n' +
      '• Ежемесячная стипендия 144 000 ¥\n' +
      '• 6 месяцев японского языка\n' +
      '• Без обязательств отработки\n\n' +
      '📌 Требования:\n' +
      '• Диплом бакалавра\n' +
      '• Возраст до 35 лет\n' +
      '• Research plan\n' +
      '• Медкомиссия\n\n' +
      '📅 Дедлайн: май',
    imageFile: '6',
  },
  {
    name: 'Chevening Scholarships (UK)',
    university: 'Oxford · Cambridge · LSE · Imperial',
    city: 'Великобритания',
    major: 'Magistracy in any field',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'GBP',
    duration: '1 год',
    language: 'Английский',
    description:
      '🇬🇧 Самый престижный британский грант, финансируемый правительством UK.\n\n' +
      '✅ Покрывается:\n' +
      '• Полная стоимость обучения\n' +
      '• Ежемесячная стипендия\n' +
      '• Авиабилеты в оба конца\n' +
      '• Visa fees\n' +
      '• Дополнительные allowances\n\n' +
      '📌 Требования:\n' +
      '• Степень бакалавра (Upper Second-Class)\n' +
      '• 2+ года work experience (минимум 2800 часов)\n' +
      '• IELTS 6.5+\n' +
      '• Принятие в 3 британских университета\n\n' +
      '📅 Дедлайн: ноябрь',
    imageFile: '7',
  },
  {
    name: 'Erasmus Mundus Joint Masters',
    university: 'Партнёрские университеты ЕС',
    city: 'Европа (несколько стран)',
    major: 'Joint Master Programs',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'EUR',
    duration: '2 года',
    language: 'Английский',
    description:
      '🇪🇺 Эразмус Мундус — программа Европейской комиссии для совместных магистратур по нескольким странам ЕС.\n\n' +
      '✅ Покрывается:\n' +
      '• Полная стоимость обучения\n' +
      '• Travel и installation allowance\n' +
      '• Ежемесячная стипендия 1400 €\n' +
      '• Медицинская страховка\n' +
      '• Возможность учиться в 2–4 странах\n\n' +
      '📌 Требования:\n' +
      '• Диплом бакалавра\n' +
      '• IELTS 6.5+ или TOEFL 90+\n' +
      '• Мотивационное письмо\n' +
      '• 2 рекомендательных письма\n\n' +
      '📅 Дедлайн: январь',
    imageFile: '8',
  },
];

// Папка, куда пользователь может положить картинки 1.jpg..N.jpg (или .png/.webp)
const IMAGES_SRC = path.join(__dirname, 'seed-programs-images');
const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');

function findImageFile(key: string): string | null {
  if (!fs.existsSync(IMAGES_SRC)) return null;
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const ext of exts) {
    const p = path.join(IMAGES_SRC, `${key}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectExt(srcPath: string): string {
  const fd = fs.openSync(srcPath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  return path.extname(srcPath).toLowerCase() || '.bin';
}

function copyToUploads(srcPath: string): string {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const ext = detectExt(srcPath);
  const dstName = `${randomUUID()}${ext}`;
  const dstPath = path.join(UPLOADS_DIR, dstName);
  fs.copyFileSync(srcPath, dstPath);
  return `/uploads/${dstName}`;
}

async function main() {
  if (process.env.SEED_IF_EMPTY === '1') {
    const count = await prisma.program.count();
    if (count > 0) {
      console.log(`✓ Программ в БД: ${count}. Пропускаем seed.`);
      return;
    }
    console.log('🌱 Программ нет — запускаю первичный seed...');
  } else {
    console.log('🌱 Seeding programs...');
  }

  for (const p of PROGRAMS) {
    const existing = await prisma.program.findFirst({ where: { name: p.name } });

    let imageUrl: string | null = null;
    if (p.imageFile) {
      const src = findImageFile(p.imageFile);
      if (src) {
        imageUrl = copyToUploads(src);
        console.log(`  🖼  Картинка для «${p.name}» → ${imageUrl}`);
      }
    }

    if (existing) {
      await prisma.program.update({
        where: { id: existing.id },
        data: {
          university: p.university,
          city: p.city,
          major: p.major,
          direction: p.direction,
          cost: p.cost,
          currency: p.currency,
          duration: p.duration,
          language: p.language,
          description: p.description,
          ...(imageUrl ? { imageUrl } : {}),
          published: true,
        },
      });
      console.log(`  ✏️  Обновлено: ${p.name}`);
    } else {
      const created = await prisma.program.create({
        data: {
          name: p.name,
          university: p.university,
          city: p.city,
          major: p.major,
          direction: p.direction,
          cost: p.cost,
          currency: p.currency,
          duration: p.duration,
          language: p.language,
          description: p.description,
          imageUrl: imageUrl || null,
          published: true,
        },
      });
      console.log(`  ➕ Создано:   ${p.name}`);
      const tg = await postToChannel(created);
      if (tg) {
        await prisma.program.update({
          where: { id: created.id },
          data: { telegramMessageId: tg.messageId, telegramHasPhoto: tg.hasPhoto },
        });
      }
    }
  }

  console.log('✅ Программы загружены.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
