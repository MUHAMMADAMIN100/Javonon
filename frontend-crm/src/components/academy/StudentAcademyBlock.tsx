import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../Icon';
import { useAuth } from '../../store/auth';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { isAcademyManager } from '../../lib/permissions';
import { FLAGS_FOR_DECISION, getStudentAcademySummary } from '../../api/academy';
import { AcademyStatusBadge, FlagDots, LevelBadge, TotalBadge, pct } from './academyUi';

/**
 * Блок «Академия» в карточке студента CRM: группа и учитель, уровень,
 * средний итог, посещаемость, красные флаги и статус. Студенту, который в
 * академии не учится, блок не показывается вовсе.
 */
export default function StudentAcademyBlock({ studentId }: { studentId: string }) {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const q = useQuery({
    queryKey: keys.academy.crm(studentId),
    queryFn: () => getStudentAcademySummary(studentId),
    retry: false,
  });
  const d = q.data;
  if (!d || !d.inAcademy) return null;

  return (
    <section className="card profile-section acad-crm-block" data-testid="client-academy">
      <div className="acad-crm-head">
        <h3 className="profile-h">{t('academy.crm.title')}</h3>
        <AcademyStatusBadge status={d.status} />
      </div>
      <div className="acad-crm-grid">
        <div>
          <span className="acad-crm-label">{t('academy.col.groups')}</span>
          <span className="acad-crm-value">
            {d.groups.length
              ? d.groups.map((g) => `${g.name}${g.teacher ? ` (${g.teacher.fullName})` : ''}`).join(', ')
              : '—'}
          </span>
        </div>
        <div>
          <span className="acad-crm-label">{t('academy.col.level')}</span>
          <LevelBadge level={d.level} />
        </div>
        <div>
          <span className="acad-crm-label">{t('academy.col.avg')}</span>
          <TotalBadge total={d.summary.avg} />
        </div>
        <div>
          <span className="acad-crm-label">{t('academy.col.attendance')}</span>
          <span className="acad-crm-value">{pct(d.summary.attendancePct)}</span>
        </div>
        <div>
          <span className="acad-crm-label">{t('academy.flags.title')}</span>
          <span className="acad-crm-value">
            <FlagDots count={d.flagsActive} /> {d.flagsActive} / {FLAGS_FOR_DECISION}
          </span>
        </div>
      </div>
      {isAcademyManager(me as any) && (
        <Link to={`/academy/students/${studentId}`} className="btn btn-secondary btn-sm acad-crm-open">
          <Icon name="school" size={16} /> {t('academy.crm.open')}
        </Link>
      )}
    </section>
  );
}
