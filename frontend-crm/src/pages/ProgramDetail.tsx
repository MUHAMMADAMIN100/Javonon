import { useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  getProgram, programImageUrl,
  listProgramDocuments, uploadProgramDocument, deleteProgramDocument,
  listProgramComments, addProgramComment, deleteProgramComment,
  type ProgramDocument, type ProgramComment,
} from '../api/programs';
import { DIRECTION_LABEL } from '../api/types';
import Icon from '../Icon';
import Loading from '../components/Loading';
import { MiniMarkdown } from '../lib/miniMarkdown';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');
const fileUrl = (u: string) => (u.startsWith('http') ? u : `${API_BASE}${u}`);

/**
 * Детальная страница программы (ТЗ-доработка п.7). Открывается по клику
 * на карточку программы. Показывает всё: фото-галерею, описание (markdown),
 * требования, дедлайны, стипендии, ссылку на сайт университета.
 */
export default function ProgramDetail() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: ['program', id],
    queryFn: () => getProgram(id!),
    enabled: !!id,
  });
  const p = query.data;
  const [activePhoto, setActivePhoto] = useState(0);

  if (!id) return null;
  if (query.isLoading) return <Loading />;
  if (query.isError || !p) {
    return (
      <motion.div className="card" style={{ padding: 28 }}>
        <Link to="/programs">{t('programs.cta.back')}</Link>
        <h2 style={{ marginTop: 16 }}>Программа не найдена</h2>
      </motion.div>
    );
  }

  const allPhotos = [p.imageUrl, ...(p.imageUrls || [])].filter(Boolean) as string[];
  const websiteUrl = (p as any).universityWebsiteUrl as string | undefined;
  const scholarships = (p as any).scholarships as any[] | undefined;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <Link to="/programs" style={{ fontSize: 13, color: 'var(--text-soft)' }}>
          {t('programs.cta.back')}
        </Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, marginBottom: 6 }}>{p.name}</h1>
            <div style={{ fontSize: 18, color: 'var(--text-soft)' }}>{p.university}</div>
            <div style={{ fontSize: 14, color: 'var(--text-soft)', marginTop: 6 }}>
              {[p.country, p.city].filter(Boolean).join(', ')}
            </div>
          </div>
          {websiteUrl && (
            <a href={websiteUrl} target="_blank" rel="noreferrer" className="btn btn-primary">
              🌐 Официальный сайт университета
            </a>
          )}
        </div>
      </div>

      {/* Галерея */}
      {allPhotos.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <img
              src={programImageUrl(allPhotos[activePhoto])!}
              alt=""
              style={{ width: '100%', maxHeight: 420, objectFit: 'cover', borderRadius: 12 }}
            />
          </div>
          {allPhotos.length > 1 && (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
              {allPhotos.map((u, idx) => (
                <img
                  key={u}
                  src={programImageUrl(u)!}
                  alt=""
                  onClick={() => setActivePhoto(idx)}
                  style={{
                    width: 96, height: 64, objectFit: 'cover', borderRadius: 8,
                    cursor: 'pointer',
                    outline: idx === activePhoto ? '2px solid var(--primary)' : 'none',
                    opacity: idx === activePhoto ? 1 : 0.7,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginBottom: 12 }}>{t('programs.section.main')}</h3>
          <Row label="Направление" value={p.direction ? DIRECTION_LABEL[p.direction] : '—'} />
          <Row label="Специальность" value={p.major || '—'} />
          <Row label="Стоимость / год" value={p.cost ? `${p.cost.toLocaleString('ru-RU')} ${p.currency}` : 'Бесплатно / уточняется'} />
          <Row label="Длительность" value={p.duration} />
          <Row label="Язык обучения" value={p.language} />
          <Row label="Уровень английского" value={p.englishLevel} />
          <Row label="Средний проходной балл" value={p.avgAdmissionScore} />
          <Row label="Дедлайн подачи" value={p.applicationDeadline} />
          <Row label="Наборов в год" value={typeof p.intakesPerYear === 'number' ? String(p.intakesPerYear) : null} />
        </div>

        {p.disciplines && p.disciplines.length > 0 && (
          <div className="card" style={{ padding: 20 }}>
            <h3 style={{ marginBottom: 12 }}>{t('programs.section.disciplines')}</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {p.disciplines.map((d: string) => (
                <span key={d} style={{
                  padding: '4px 10px', borderRadius: 999,
                  background: 'var(--bg-soft)', border: '1px solid var(--border)',
                  fontSize: 13,
                }}>{d}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {scholarships && scholarships.length > 0 && (
        <div className="card" style={{ padding: 20, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>🎓 Стипендии и гранты ({scholarships.length})</h3>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Покрытие</th>
                <th>Сумма</th>
                <th>Что включено</th>
                <th>Требования</th>
                <th>Дедлайн</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scholarships.map((s: any) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td>{s.coverage || '—'}</td>
                  <td>{s.amount || '—'}</td>
                  <td>{s.includes || '—'}</td>
                  <td>{s.requirements || '—'}</td>
                  <td>{s.deadline || '—'}</td>
                  <td>
                    {s.link && (
                      <a href={s.link} target="_blank" rel="noreferrer">🔗</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.description && (
        <div className="card" style={{ padding: 20, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('programs.section.description')}</h3>
          <MiniMarkdown text={p.description} />
        </div>
      )}

      {/* Документы программы (ТЗ п.7) */}
      <ProgramDocumentsSection programId={p.id} />

      {/* Комментарии (ТЗ п.7) */}
      <ProgramCommentsSection programId={p.id} />
    </motion.div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ color: 'var(--text-soft)', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ProgramDocumentsSection({ programId }: { programId: string }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const query = useQuery({
    queryKey: ['program-documents', programId],
    queryFn: () => listProgramDocuments(programId),
  });
  const items = query.data ?? [];
  const canEdit = isElevated(me as any);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      await uploadProgramDocument(programId, file);
      qc.invalidateQueries({ queryKey: ['program-documents', programId] });
      toast('Документ загружен', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally { setUploading(false); }
  };
  const remove = async (d: ProgramDocument) => {
    const ok = await confirm({ title: 'Удалить документ?', message: d.name, danger: true });
    if (!ok) return;
    await deleteProgramDocument(d.id);
    qc.invalidateQueries({ queryKey: ['program-documents', programId] });
  };

  return (
    <div className="card" style={{ padding: 20, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3>{t('programs.section.documents')} ({items.length})</h3>
        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? t('common.uploading') : t('programs.documents.add')}
            </button>
          </>
        )}
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('programs.documents.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((d) => (
            <div key={d.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <a
                href={fileUrl(d.url)}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 1, color: 'inherit', textDecoration: 'none' }}
              >
                📄 {d.name}
                {d.size ? <span style={{ color: 'var(--text-soft)', fontSize: 12, marginLeft: 8 }}>
                  ({(d.size / 1024).toFixed(0)} KB)
                </span> : null}
              </a>
              {canEdit && (
                <button className="btn btn-sm btn-danger" onClick={() => remove(d)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgramCommentsSection({ programId }: { programId: string }) {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const query = useQuery({
    queryKey: ['program-comments', programId],
    queryFn: () => listProgramComments(programId),
  });
  const items = query.data ?? [];

  const submit = async () => {
    const t = draft.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await addProgramComment(programId, t);
      setDraft('');
      qc.invalidateQueries({ queryKey: ['program-comments', programId] });
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally { setSending(false); }
  };
  const remove = async (c: ProgramComment) => {
    const ok = await confirm({ title: 'Удалить комментарий?', message: c.text, danger: true });
    if (!ok) return;
    await deleteProgramComment(c.id);
    qc.invalidateQueries({ queryKey: ['program-comments', programId] });
  };

  return (
    <div className="card" style={{ padding: 20, marginTop: 16 }}>
      <h3 style={{ marginBottom: 12 }}>{t('programs.section.comments')} ({items.length})</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'flex-start' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('programs.comments.placeholder')}
          rows={2}
          maxLength={4000}
          style={{ flex: 1, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={!draft.trim() || sending}
          // alignSelf + flexShrink:0 чтобы кнопка не вытягивалась когда
          // пользователь увеличивает textarea ручкой resize. ТЗ-фикс.
          style={{ alignSelf: 'flex-start', flexShrink: 0 }}
        >
          {sending ? t('common.sending') : t('common.send')}
        </button>
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{t('programs.comments.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((c) => (
            <div key={c.id} style={{
              padding: 12, border: '1px solid var(--border)', borderRadius: 10,
              background: 'var(--bg-soft)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{c.authorName}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-soft)', fontSize: 11 }}>
                    {new Date(c.createdAt).toLocaleString('ru-RU')}
                  </span>
                  {(c.authorId === me?.id || isElevated(me as any)) && (
                    <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>×</button>
                  )}
                </div>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5 }}>{c.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
