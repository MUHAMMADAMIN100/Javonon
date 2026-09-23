import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import CrmSelect from './CrmSelect';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { absFileUrl } from '../lib/fileUrl';
import { listPipelines, moveApplicationStage } from '../api/sales';
import {
  APPLICATION_STATUSES,
  STATUS_BADGE,
  isClientNotifiedApplicationStatus,
  isLegacyApplicationStatus,
  type ApplicationStatus,
} from '../api/types';
import { useApplicationStatusLabel } from '../lib/labels';
import { tjFormatDate, tjYMD } from '../lib/tjTime';
import { heroColor, heroInitials } from './ProfileParts';

/**
 * Карточка клиента — заявка (ApplicationDetail) и студент (StudentDetail).
 * Устроена как карточка сотрудника: шапка с аватаром, именем и действиями,
 * под именем — компактные «таблетки» статуса, этапа воронки и долга (по
 * ширине текста, без длинных селектов), ниже — данные плотной сеткой.
 * Обе страницы собраны из этих деталей, поэтому выглядят одинаково.
 */

/**
 * wa.me принимает только цифры — «+992 90 123-45-67» → «992901234567».
 * Возвращает null для пустого/мусорного номера, чтобы вместо битой ссылки
 * отрисовать прочерк.
 */
export function waLink(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? `https://wa.me/${digits}` : null;
}

export function telLink(phone: string | null | undefined): string | null {
  const clean = String(phone ?? '').replace(/[^\d+]/g, '');
  return clean.replace(/\D/g, '').length >= 7 ? `tel:${clean}` : null;
}

/**
 * Возраст на сегодня в Asia/Dushanbe — тот же часовой пояс, в котором бэкенд
 * проверяет диапазон 14..60 при создании заявки. Обе даты (рождения и
 * «сегодня») приводим к TJ-календарю через tjYMD, чтобы сравнивать
 * сопоставимые Y/M/D: дата с лендинга хранится как душанбинская полночь, и
 * 12 марта приходит в JSON как 11 марта 19:00Z.
 */
function ageFromBirthday(iso: string): number | null {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  const { y: by, m: bm, d: bd } = tjYMD(date);
  const today = tjYMD();
  let age = today.y - by;
  if (today.m < bm || (today.m === bm && today.d < bd)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** 21 год · 22 года · 25 лет — русские формы множественного числа. */
function agePluralKey(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'app.age.many';
  const mod10 = n % 10;
  if (mod10 === 1) return 'app.age.one';
  if (mod10 >= 2 && mod10 <= 4) return 'app.age.few';
  return 'app.age.many';
}

/** Дата рождения с возрастом: «07.05.2009 · 17 лет». TJ-календарь, а не пояс браузера. */
export function BirthdayValue({ iso }: { iso?: string | null }) {
  const { t } = useT();
  if (!iso) return <>—</>;
  const age = ageFromBirthday(iso);
  return (
    <>
      {tjFormatDate(iso) || iso}
      {age !== null && <span className="client-field-sub"> · {age} {t(agePluralKey(age))}</span>}
    </>
  );
}

export type ClientContact = { icon: string; text: string; href?: string | null; title?: string; external?: boolean; testId?: string };

/** Шапка: аватар (фото или инициалы), имя, таблетки, контакты и действия. */
export function ClientHero({
  eyebrow,
  name,
  avatarId,
  photoUrl,
  enrolled,
  onPhotoPick,
  photoBusy,
  controls,
  contacts,
  actions,
}: {
  eyebrow: string;
  name: string;
  /** От него зависит цвет аватара — постоянный для клиента. */
  avatarId: string;
  photoUrl?: string | null;
  /** Успешный лид — зелёная обводка аватара и значок у имени. */
  enrolled?: boolean;
  /** Есть — на аватаре кнопка «загрузить фото». */
  onPhotoPick?: (file: File) => void;
  photoBusy?: boolean;
  controls?: ReactNode;
  contacts: ClientContact[];
  actions?: ReactNode;
}) {
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const photoTitle = photoUrl ? t('client.photo.change') : t('studentDetail.action.uploadPhoto');

  return (
    <section className="card profile-hero client-hero" data-testid="client-hero">
      <div className="client-avatar">
        <span
          className={`profile-hero-avatar${enrolled ? ' is-enrolled' : ''}${photoUrl ? ' has-photo' : ''}`}
          style={photoUrl ? undefined : { background: heroColor(avatarId) }}
          data-testid="client-avatar"
        >
          {photoUrl ? <img src={absFileUrl(photoUrl)} alt="" /> : heroInitials(name)}
        </span>
        {onPhotoPick && (
          <>
            <button
              type="button"
              className="client-avatar-cam"
              onClick={() => fileRef.current?.click()}
              disabled={photoBusy}
              title={photoTitle}
              aria-label={photoTitle}
              data-testid="client-photo-btn"
            >
              <Icon name={photoBusy ? 'progress_activity' : 'photo_camera'} size={16} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              data-testid="client-photo-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Сбрасываем, чтобы повторный выбор того же файла снова сработал.
                e.target.value = '';
                if (file) onPhotoPick(file);
              }}
            />
          </>
        )}
      </div>
      <div className="profile-hero-main">
        <span className="crm-section-eyebrow profile-hero-eyebrow">{eyebrow}</span>
        <h2 className="crm-section-title profile-hero-name" data-testid="client-name">
          {name}
          {enrolled && (
            <span className="client-enrolled-mark" title={statusLabel('SUCCESSFUL_LEAD')}>
              <Icon name="verified" size={22} />
            </span>
          )}
        </h2>
        {controls && <div className="client-controls" data-testid="client-controls">{controls}</div>}
        {contacts.length > 0 && (
          <div className="profile-hero-contacts" data-testid="client-contacts">
            {contacts.map((c, i) =>
              c.href ? (
                <a
                  key={i}
                  className="profile-hero-contact"
                  href={c.href}
                  title={c.title}
                  data-testid={c.testId}
                  {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <Icon name={c.icon} size={16} />{c.text}
                </a>
              ) : (
                <span key={i} className="profile-hero-contact" title={c.title} data-testid={c.testId}>
                  <Icon name={c.icon} size={16} />{c.text}
                </span>
              ),
            )}
          </div>
        )}
      </div>
      {actions && <div className="profile-hero-actions">{actions}</div>}
    </section>
  );
}

const BADGE_TONE: Record<string, string> = {
  'badge-info': 'info',
  'badge-warning': 'warning',
  'badge-gray': 'gray',
  'badge-danger': 'danger',
  'badge-success': 'success',
};
function statusTone(status: string): string {
  return BADGE_TONE[STATUS_BADGE[status as ApplicationStatus] || 'badge-gray'] || 'gray';
}

/**
 * Таблетка-список: подпись и выбранное значение в одной рамке по ширине
 * текста. Внутри — обычный CrmSelect (тот же список вариантов, что везде).
 */
function PillSelect({
  prefix,
  tone,
  style,
  testId,
  title,
  value,
  disabled,
  onChange,
  children,
}: {
  prefix?: string;
  tone: string;
  style?: CSSProperties;
  testId: string;
  title: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  return (
    <span ref={ref} className={`client-pill has-select is-${tone}`} style={style} data-testid={testId}>
      {prefix && (
        <span
          className="client-pill-prefix"
          onClick={() => ref.current?.querySelector<HTMLButtonElement>('.crm-select-trigger')?.click()}
        >
          {prefix}
        </span>
      )}
      <CrmSelect className="client-pill-select" value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)}>
        {children}
      </CrmSelect>
    </span>
  );
}

/** Статус заявки. Без права менять — просто цветная плашка. */
export function StatusPill({ status, canEdit, busy, onChange }: {
  status: ApplicationStatus;
  canEdit: boolean;
  busy?: boolean;
  onChange: (status: ApplicationStatus) => void;
}) {
  const { t } = useT();
  const label = useApplicationStatusLabel();
  const tone = statusTone(status);
  if (!canEdit) {
    return <span className={`client-pill is-status is-${tone}`} data-testid="client-status" title={t('app.field.status')}>{label(status)}</span>;
  }
  return (
    <PillSelect
      tone={`${tone} is-status`}
      testId="client-status"
      title={t('app.field.status')}
      value={status}
      disabled={busy}
      onChange={(v) => v !== status && onChange(v as ApplicationStatus)}
    >
      {/* Заявка до миграции: её статуса нет в списке предлагаемых, но
          выбранным значением он обязан показываться. */}
      {isLegacyApplicationStatus(status) && (
        <option value={status} disabled>{label(status)}</option>
      )}
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>{label(s)}</option>
      ))}
    </PillSelect>
  );
}

/**
 * Этап воронки: таблетка в цвете этапа. Воронок в системе нет — таблетки нет.
 * Меняет этап сразу (moveApplicationStage), после — onChanged перечитывает карточку.
 */
export function StagePill({ applicationId, pipelineId, stageId, canEdit, onChanged }: {
  applicationId: string;
  pipelineId: string | null | undefined;
  stageId: string | null | undefined;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const query = useQuery({ queryKey: ['sales', 'pipelines'], queryFn: listPipelines });
  const pipelines = query.data ?? [];
  const [busy, setBusy] = useState(false);

  if (pipelines.length === 0) return null;
  const pipeline = pipelines.find((p) => p.id === pipelineId) || pipelines.find((p) => p.isDefault) || pipelines[0];
  const stage = pipeline.stages.find((s) => s.id === stageId);
  const colored: CSSProperties | undefined = stage?.color
    ? ({ '--pill-bg': `${stage.color}1f`, '--pill-border': stage.color, '--pill-fg': stage.color } as CSSProperties)
    : undefined;
  const title = `${t('app.field.pipeline')}: ${pipeline.name}`;

  if (!canEdit) {
    return (
      <span className="client-pill is-plain" style={colored} title={title} data-testid="client-stage">
        <span className="client-pill-prefix">{t('app.field.stage')}</span>
        {stage?.name ?? '—'}
      </span>
    );
  }

  // «—» снимает этап: сервер на пустое значение ставит pipelineStageId = null.
  const onPick = async (next: string) => {
    if (next === (stageId || '')) return;
    setBusy(true);
    try {
      await moveApplicationStage(applicationId, next || null);
      toast(t('toast.updated'), 'success');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PillSelect
      prefix={t('app.field.stage')}
      tone="plain"
      style={colored}
      testId="client-stage"
      title={title}
      value={stageId || ''}
      disabled={busy}
      onChange={onPick}
    >
      <option value="">—</option>
      {pipeline.stages.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}{s.isClosingStage ? ' ✓' : ''}
        </option>
      ))}
    </PillSelect>
  );
}

/**
 * Долг — отдельный флаг заявки (Application.paymentPending), а не статус:
 * «Успешный лид» вполне может быть должником. Флаг читают «Финансы» и
 * карточка дашборда «Студентов с задолженностью».
 */
export function DebtPill({ pending, canEdit, busy, onChange }: {
  pending: boolean;
  canEdit: boolean;
  busy?: boolean;
  onChange: (pending: boolean) => void;
}) {
  const { t } = useT();
  if (!canEdit) {
    return (
      <span className={`client-pill ${pending ? 'is-warning' : 'is-gray'}`} data-testid="client-debt">
        {pending ? t('app.debt.pending') : t('app.debt.none')}
      </span>
    );
  }
  return (
    <label
      className={`client-pill client-pill-check ${pending ? 'is-warning' : 'is-plain'}${busy ? ' is-busy' : ''}`}
      title={t('app.debt.hint')}
      data-testid="client-debt"
    >
      <input type="checkbox" checked={pending} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      {t('app.debt.toggle')}
    </label>
  );
}

/**
 * Уйдёт ли клиенту SMS при этом статусе. Половина статусов — внутренняя
 * квалификация («Думает», «Некачественные лиды»), по ней бэкенд молчит, и
 * менеджер обязан видеть эту разницу. Коротко, полная фраза — в подсказке.
 */
export function SmsNote({ status }: { status: ApplicationStatus }) {
  const { t } = useT();
  const on = isClientNotifiedApplicationStatus(status);
  return (
    <span
      className={`client-sms${on ? ' is-on' : ''}`}
      title={on ? t('app.status.smsSent') : t('app.status.smsSilent')}
      data-testid="client-sms"
    >
      <Icon name={on ? 'sms' : 'notifications_off'} size={15} />
      {on ? t('client.sms.on') : t('client.sms.off')}
    </span>
  );
}

/** Пустой блок одной строкой: «История общения — записей пока нет». */
export function EmptyLine({ title, text, actions, testId }: { title: string; text: string; actions?: ReactNode; testId?: string }) {
  return (
    <section className="card profile-section is-empty client-empty-line" data-testid={testId}>
      <h3 className="profile-h">{title}</h3>
      <span className="profile-empty">{text}</span>
      {actions && <span className="client-empty-actions">{actions}</span>}
    </section>
  );
}
