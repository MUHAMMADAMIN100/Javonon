import { motion } from 'framer-motion';
import Icon from '../Icon';
import { STUDENT_STAGES, resolveStudentStage } from '../applicationStage';

/**
 * Шкала «где моя заявка» в кабинете студента.
 *
 * Что статус означает для студента, решает ../applicationStage.ts — здесь
 * только отрисовка. Разделение не косметическое: прежняя версия держала
 * лестницу из шести этапов старой воронки прямо в компоненте и добивала
 * промах `findIndex` через `Math.max(0, -1)`. После
 * backend/prisma/migrate-lead-statuses.ts API отдаёт NEW_LEAD…SUCCESSFUL_LEAD,
 * в лестницу не попадало ни одно из них, и КАЖДЫЙ студент — включая
 * зачисленных — видел «Аризаи нав, 0%». Без ошибки и без следа в CRM.
 *
 * Отсюда правило: индекс шага берётся только из resolveStudentStage. Ступеней
 * три, потому что новые статусы — исходы квалификации, а не лестница
 * (см. разбор в applicationStage.ts). Состояния «не знаем такой статус» и
 * «внутренняя оценка лида» рисуются карточкой без шкалы и без процента.
 * Фолбэка «ну пусть будет первый шаг» здесь нет намеренно — он и был багом.
 */

type Props = {
  currentStatus?: string | null;
};

/** Куда отправлять студента за подробностями, если шкалу показать нельзя. */
const ASK_MANAGER = 'Барои маълумоти дақиқ бо менеҷери худ дар тамос шавед.';

/**
 * Карточка без шкалы: заявка есть, но ставить её на конкретную ступень мы
 * не вправе. Процент не рисуем вообще — любое число тут было бы выдумкой.
 */
function EnrollmentNote({ title }: { title: string }) {
  return (
    <div className="ep-card">
      <div className="ep-head">
        <div>
          <div className="ep-title">Марҳилаи қабул</div>
          <div className="ep-current">{title}</div>
          <div className="ep-hint">{ASK_MANAGER}</div>
        </div>
      </div>
    </div>
  );
}

export default function EnrollmentProgress({ currentStatus }: Props) {
  const stage = resolveStudentStage(currentStatus);

  // Заявки нет — прогрессу неоткуда взяться. Пустая карточка «Аризаи нав»
  // сообщала бы студенту о заявке, которой не существует.
  if (stage.kind === 'none') return null;

  // OUT_OF_TOWN / UNDER_17 / LOW_QUALITY_LEAD — оценка лида для менеджера.
  // Показывать её студенту нельзя, изображать движение по этапам — тоже.
  if (stage.kind === 'internal') {
    return <EnrollmentNote title="Ариза сабт шудааст" />;
  }

  // Схема ушла вперёд, а лендинг не обновили. Честнее сказать «не знаем»,
  // чем нарисовать первый шаг: молчаливый индекс 0 никто не замечал годами.
  if (stage.kind === 'unknown') {
    return <EnrollmentNote title="Ҳолати ариза муайян нашуд" />;
  }

  const currentIdx = stage.index;
  const percent = Math.round((currentIdx / (STUDENT_STAGES.length - 1)) * 100);

  return (
    <div className="ep-card">
      <div className="ep-head">
        <div>
          <div className="ep-title">Марҳилаи қабул</div>
          <div className="ep-current">{STUDENT_STAGES[currentIdx].label}</div>
        </div>
        <div className="ep-percent">{percent}%</div>
      </div>

      <div className="ep-track">
        {STUDENT_STAGES.map((s, i) => {
          const done = i < currentIdx;
          const current = i === currentIdx;
          return (
            <div key={s.key} className={`ep-step${done ? ' done' : ''}${current ? ' current' : ''}`}>
              <motion.div
                className="ep-dot"
                initial={{ scale: 0.8 }}
                animate={{ scale: current ? 1.1 : 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              >
                {done ? <Icon name="check" size={14} /> : <span>{i + 1}</span>}
              </motion.div>
              <div className="ep-label">{s.short}</div>
              {i < STUDENT_STAGES.length - 1 && (
                <div className="ep-connector">
                  <motion.div
                    className="ep-connector-fill"
                    initial={{ width: 0 }}
                    animate={{ width: done ? '100%' : '0%' }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
