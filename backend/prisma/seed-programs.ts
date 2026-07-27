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
//
// ВАЖНО: все пользовательские строки (city, major, duration, language,
// description) — на таджикском. Эти поля рендерятся публично на лендинге
// (PublicProgramsSection — карточки, PublicProgramDetail — детальная), а
// лендинг целиком таджикоязычный. Названия стран берём из справочника
// лендинга (frontend-landing/src/components/Directions.tsx): Хитой, ИМА,
// Олмон, Кореяи Ҷанубӣ, Туркия, Ҷопон, Британияи Кабир, Иттиҳоди Аврупо.
// Комментарии в коде остаются на русском — как и во всём репозитории.
//
// Экспортируется, чтобы prisma/migrate-programs-tj.ts мог переписать
// уже засеянные русские строки в проде, не дублируя тексты.
export const PROGRAMS: SeedProgram[] = [
  {
    name: 'Chinese Government Scholarship — Tsinghua University',
    university: 'Tsinghua University',
    city: 'Пекин, Хитой',
    major: 'Computer Science · Engineering · Business',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '2–3 сол',
    language: 'Англисӣ / Хитоӣ',
    description:
      '🇨🇳 Гранти пурраи ҳукумати Хитой (CSC) ба яке аз беҳтарин донишгоҳҳои Осиё.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• 100% арзиши таҳсил\n' +
      '• Зиндагӣ дар кампус\n' +
      '• Суғуртаи тиббӣ\n' +
      '• Стипендияи моҳона 3000 ¥\n\n' +
      '📌 Талабот:\n' +
      '• Синну сол то 35 сол\n' +
      '• Дипломи бакалавр (барои магистратура)\n' +
      '• IELTS 6.5+ ё HSK 5\n' +
      '• Номаи ангезишӣ + 2 тавсиянома\n\n' +
      '📅 Мӯҳлат: апрели ҳар сол',
    imageFile: '1',
  },
  {
    name: 'Fulbright Scholarship Program',
    university: 'Top US Universities',
    city: 'ИМА (иёлотҳои гуногун)',
    major: 'Ҳамаи самтҳои магистратура ва PhD',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '1–2 сол',
    language: 'Англисӣ',
    description:
      '🇺🇸 Бонуфузтарин гранти амрикоӣ барои таҳсил дар ИМА.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Арзиши пурраи таҳсил\n' +
      '• Чиптаҳои ҳавопаймо ба ҳарду тараф\n' +
      '• Стипендияи моҳона барои зиндагӣ\n' +
      '• Суғуртаи тиббӣ\n' +
      '• Хароҷот барои маводи таълимӣ\n\n' +
      '📌 Талабот:\n' +
      '• Дараҷаи бакалавр бо GPA 3.5+\n' +
      '• TOEFL 90+ ё IELTS 7.0+\n' +
      '• GRE/GMAT (барои баъзе барномаҳо)\n' +
      '• Эссеи қавӣ ва таҷрибаи корӣ\n\n' +
      '📅 Мӯҳлат: май–июн',
    imageFile: '2',
  },
  {
    name: 'DAAD Stipendium — German Universities',
    university: 'TU Munich · Heidelberg · Berlin',
    city: 'Олмон',
    major: 'Engineering · Sciences · Humanities',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'EUR',
    duration: '1–2 сол',
    language: 'Англисӣ / Олмонӣ',
    description:
      '🇩🇪 Хадамоти мубодилаи академии Олмон (DAAD) — бузургтарин барномаи стипендиявии Аврупо.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Таҳсили ройгон дар донишгоҳҳои давлатӣ\n' +
      '• Стипендияи моҳона 934 €\n' +
      '• Суғуртаи тиббӣ\n' +
      '• Ҷубронпулии сафар (travel allowance)\n' +
      '• Курсҳои забони олмонӣ пеш аз оғози таҳсил\n\n' +
      '📌 Талабот:\n' +
      '• Дипломи бакалавр (баҳоҳои хуб)\n' +
      '• IELTS 6.5+ ё TestDaF 4\n' +
      '• Таҷрибаи корӣ 2+ сол\n' +
      '• Нақшаи таҳқиқот (research proposal)\n\n' +
      '📅 Мӯҳлат: октябр',
    imageFile: '3',
  },
  {
    name: 'Global Korea Scholarship (GKS)',
    university: 'Seoul National University · KAIST',
    city: 'Сеул, Кореяи Ҷанубӣ',
    major: 'IT · Engineering · Korean Studies',
    direction: Direction.BACHELOR,
    cost: 0,
    currency: 'USD',
    duration: '4 + 1 сол',
    language: 'Кореягӣ / Англисӣ',
    description:
      '🇰🇷 Бузургтарин стипендияи кореягӣ барои донишҷӯёни хориҷӣ.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• 100% арзиши таҳсил\n' +
      '• Як соли омодагии забонӣ ройгон\n' +
      '• Стипендияи моҳона 900 000 ₩\n' +
      '• Чиптаи ҳавопаймо рафту баргашт\n' +
      '• Суғуртаи тиббӣ + хароҷоти ҷойгиршавӣ\n\n' +
      '📌 Талабот:\n' +
      '• Синну сол то 25 сол\n' +
      '• Шаҳодатнома бо GPA 80%+\n' +
      '• TOPIK 3+ ё IELTS 5.5+\n' +
      '• Мусоҳибаи ниҳоӣ\n\n' +
      '📅 Мӯҳлат: сентябр',
    imageFile: '4',
  },
  {
    name: 'Türkiye Bursları (Turkey Scholarships)',
    university: 'Istanbul · Ankara · Izmir',
    city: 'Туркия',
    major: 'Ҳамаи самтҳо',
    direction: Direction.BACHELOR,
    cost: 0,
    currency: 'USD',
    duration: '4 сол',
    language: 'Туркӣ / Англисӣ',
    description:
      '🇹🇷 Гранти пурраи давлатии Туркия барои донишҷӯёни хориҷӣ.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Арзиши пурраи таҳсил\n' +
      '• Зиндагии ройгон дар хобгоҳ\n' +
      '• Стипендияи моҳона 3500 ₺\n' +
      '• Як соли забони туркӣ\n' +
      '• Суғуртаи тиббӣ\n' +
      '• Чиптаҳои ҳавопаймо\n\n' +
      '📌 Талабот:\n' +
      '• Шаҳодатнома бо баҳоҳои 70%+\n' +
      '• Синну сол то 21 сол (бакалавр)\n' +
      '• Донистани забон ҳатмӣ нест (як соли омодагӣ)\n\n' +
      '📅 Мӯҳлат: феврал',
    imageFile: '5',
  },
  {
    name: 'MEXT Japanese Government Scholarship',
    university: 'University of Tokyo · Kyoto · Osaka',
    city: 'Ҷопон',
    major: 'Sciences · Engineering · Japanese Studies',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'USD',
    duration: '2 сол',
    language: 'Ҷопонӣ / Англисӣ',
    description:
      '🇯🇵 Гранти Вазорати маорифи Ҷопон (MEXT).\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Таҳсили пурра\n' +
      '• Чиптаҳои ҳавопаймо\n' +
      '• Стипендияи моҳона 144 000 ¥\n' +
      '• 6 моҳ забони ҷопонӣ\n' +
      '• Бидуни ӯҳдадории кор карда додан\n\n' +
      '📌 Талабот:\n' +
      '• Дипломи бакалавр\n' +
      '• Синну сол то 35 сол\n' +
      '• Нақшаи таҳқиқот (research plan)\n' +
      '• Комиссияи тиббӣ\n\n' +
      '📅 Мӯҳлат: май',
    imageFile: '6',
  },
  {
    name: 'Chevening Scholarships (UK)',
    university: 'Oxford · Cambridge · LSE · Imperial',
    city: 'Британияи Кабир',
    major: 'Magistracy in any field',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'GBP',
    duration: '1 сол',
    language: 'Англисӣ',
    description:
      '🇬🇧 Бонуфузтарин гранти британӣ, ки аз ҷониби ҳукумати Британия маблағгузорӣ мешавад.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Арзиши пурраи таҳсил\n' +
      '• Стипендияи моҳона\n' +
      '• Чиптаҳои ҳавопаймо рафту баргашт\n' +
      '• Хароҷоти виза (visa fees)\n' +
      '• Ҷубронпулиҳои иловагӣ\n\n' +
      '📌 Талабот:\n' +
      '• Дараҷаи бакалавр (Upper Second-Class)\n' +
      '• 2+ сол таҷрибаи корӣ (ҳадди ақал 2800 соат)\n' +
      '• IELTS 6.5+\n' +
      '• Қабул ба 3 донишгоҳи британӣ\n\n' +
      '📅 Мӯҳлат: ноябр',
    imageFile: '7',
  },
  {
    name: 'Erasmus Mundus Joint Masters',
    university: 'Донишгоҳҳои шарики Иттиҳоди Аврупо',
    city: 'Аврупо (якчанд кишвар)',
    major: 'Joint Master Programs',
    direction: Direction.MASTER,
    cost: 0,
    currency: 'EUR',
    duration: '2 сол',
    language: 'Англисӣ',
    description:
      '🇪🇺 Erasmus Mundus — барномаи Комиссияи Аврупо барои магистратураҳои муштарак дар якчанд кишвари Иттиҳоди Аврупо.\n\n' +
      '✅ Фаро гирифта мешавад:\n' +
      '• Арзиши пурраи таҳсил\n' +
      '• Ҷубронпулии сафар ва ҷойгиршавӣ\n' +
      '• Стипендияи моҳона 1400 €\n' +
      '• Суғуртаи тиббӣ\n' +
      '• Имконияти таҳсил дар 2–4 кишвар\n\n' +
      '📌 Талабот:\n' +
      '• Дипломи бакалавр\n' +
      '• IELTS 6.5+ ё TOEFL 90+\n' +
      '• Номаи ангезишӣ\n' +
      '• 2 номаи тавсиявӣ\n\n' +
      '📅 Мӯҳлат: январ',
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

// Запускаем сид только когда файл вызван напрямую (ts-node prisma/seed-programs.ts).
// prisma/migrate-programs-tj.ts импортирует отсюда PROGRAMS — при импорте сид
// стартовать не должен, иначе миграция дёрнула бы create/update и посты в Telegram.
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
