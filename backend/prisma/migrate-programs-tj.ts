/**
 * Миграция каталога программ на таджикский.
 *
 * Зачем. Первые версии prisma/seed-programs.ts засеяли Program русскими
 * строками (city «Пекин, Китай», duration «2–3 года», language «Английский /
 * Китайский», major «Любые направления магистратуры и PhD», многоабзацные
 * description «✅ Покрывается: …»). Эти поля рендерятся публично на лендинге —
 * PublicProgramsSection (карточки) и PublicProgramDetail (детальная), — а
 * лендинг целиком таджикоязычный. Получался русский текст на таджикской
 * странице.
 *
 * Почему одного исправления сида мало. В проде backend стартует как
 * `SEED_IF_EMPTY=1 ts-node prisma/seed-programs.ts`: если в Program есть хоть
 * одна строка, сид молча выходит и НЕ обновляет уже засеянные русские записи.
 * То есть правка сида чинит только пустую БД. Этот скрипт чинит уже
 * задеплоенную.
 *
 * Что делает: для каждой программы из PROGRAMS (матч по name) переписывает
 * поле на таджикский ТОЛЬКО если в БД лежит ровно то самое старое русское
 * значение. Если админ уже правил поле руками — значение не совпадёт с
 * легаси, и мы его не трогаем. description переписываем, если он всё ещё
 * содержит русский маркер старого сида.
 *
 * Идемпотентно: после первого прогона значения больше не совпадают с легаси,
 * и скрипт ничего не делает.
 */
import { PrismaClient } from '@prisma/client';
import { PROGRAMS } from './seed-programs';

const prisma = new PrismaClient();

/** Локализуемые короткие поля каталога. */
type LocalizedField = 'university' | 'city' | 'major' | 'duration' | 'language';

/**
 * Старые русские значения из первой версии сида — заморожены здесь намеренно.
 * Это исторический снимок «что было в БД», он не должен меняться вместе с
 * будущими правками PROGRAMS. Ключ — Program.name (он никогда не был русским).
 */
const LEGACY_RU: Record<string, Partial<Record<LocalizedField, string>>> = {
  'Chinese Government Scholarship — Tsinghua University': {
    city: 'Пекин, Китай',
    duration: '2–3 года',
    language: 'Английский / Китайский',
  },
  'Fulbright Scholarship Program': {
    city: 'США (различные штаты)',
    major: 'Любые направления магистратуры и PhD',
    duration: '1–2 года',
    language: 'Английский',
  },
  'DAAD Stipendium — German Universities': {
    city: 'Германия',
    duration: '1–2 года',
    language: 'Английский / Немецкий',
  },
  'Global Korea Scholarship (GKS)': {
    city: 'Сеул, Южная Корея',
    duration: '4 + 1 года',
    language: 'Корейский / Английский',
  },
  'Türkiye Bursları (Turkey Scholarships)': {
    city: 'Турция',
    major: 'Все направления',
    duration: '4 года',
    language: 'Турецкий / Английский',
  },
  'MEXT Japanese Government Scholarship': {
    city: 'Япония',
    duration: '2 года',
    language: 'Японский / Английский',
  },
  'Chevening Scholarships (UK)': {
    city: 'Великобритания',
    duration: '1 год',
    language: 'Английский',
  },
  'Erasmus Mundus Joint Masters': {
    university: 'Партнёрские университеты ЕС',
    city: 'Европа (несколько стран)',
    duration: '2 года',
    language: 'Английский',
  },
};

/**
 * Маркер русского description из старого сида — он был во всех восьми
 * программах. Если строка всё ещё содержит его, описание не локализовано.
 */
const LEGACY_DESCRIPTION_MARKER = '✅ Покрывается:';

const FIELDS: LocalizedField[] = ['university', 'city', 'major', 'duration', 'language'];

async function main() {
  console.log('🔄 Migrating program catalog RU → TJ...');

  let updated = 0;
  let skipped = 0;

  for (const p of PROGRAMS) {
    const legacy = LEGACY_RU[p.name];
    if (!legacy) continue;

    const existing = await prisma.program.findFirst({ where: { name: p.name } });
    if (!existing) {
      // Программы нет — её засеет seed-programs.ts уже с таджикским текстом.
      continue;
    }

    const data: Partial<Record<LocalizedField | 'description', string>> = {};

    for (const field of FIELDS) {
      const legacyValue = legacy[field];
      const nextValue = p[field];
      // Трогаем поле, только если в БД лежит ровно старое русское значение.
      if (legacyValue && nextValue && existing[field] === legacyValue && nextValue !== legacyValue) {
        data[field] = nextValue;
      }
    }

    if (existing.description && existing.description.includes(LEGACY_DESCRIPTION_MARKER)) {
      data.description = p.description;
    }

    if (Object.keys(data).length === 0) {
      skipped++;
      continue;
    }

    await prisma.program.update({ where: { id: existing.id }, data });
    updated++;
    console.log(`  ✏️  ${p.name} → tj (${Object.keys(data).join(', ')})`);
  }

  if (updated === 0) {
    console.log(`  · Русских программ не найдено — уже на таджикском (проверено: ${skipped})`);
  }
  console.log(`✅ Program catalog RU → TJ: обновлено ${updated}, без изменений ${skipped}.`);
}

main()
  .catch((e) => {
    console.error('Program TJ migration failed:', e);
    // НЕ роняем процесс — start:prod должен продолжить загрузку приложения.
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
