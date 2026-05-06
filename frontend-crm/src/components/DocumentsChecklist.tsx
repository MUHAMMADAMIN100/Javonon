import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { Document } from '../api/types';
import { deleteDocument, uploadDocument } from '../api/students';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');

export const REQUIRED_DOCUMENTS: { type: string; label: string; hint?: string }[] = [
  { type: 'PHOTO', label: 'Фото 3/4', hint: 'В электронном формате' },
  { type: 'PASSPORT', label: 'Загран паспорт' },
  { type: 'BANK', label: 'Справка с банка' },
  { type: 'MEDICAL', label: 'Мед.справка (для Китая)' },
  { type: 'NO_CRIMINAL', label: 'Справка о несудимости' },
  { type: 'STUDY_PLAN', label: 'Study Plan (Мотивационное письмо)' },
  { type: 'CERTIFICATE', label: 'Certificate', hint: 'IELTS, TOEFL, DUOLINGO, HSK, CSCA (если есть)' },
  { type: 'PARENTS_PASSPORT', label: 'Паспорт родителей' },
  { type: 'DIPLOMA', label: 'Аттестат', hint: 'Или табель оценок + справка со школы' },
  { type: 'RECOMMENDATION', label: 'Рекомендательное письмо' },
];

const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / 1024 / 1024).toFixed(2)} МБ`;
};

type Props = {
  studentId: string;
  studentName?: string;
  documents: Document[];
  applicationForm?: any;
  onChange: () => void;
  editable: boolean;
};

const sanitizeFileName = (s: string) =>
  s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 80);

export default function DocumentsChecklist({ studentId, studentName, documents, applicationForm, onChange, editable }: Props) {
  const { confirm, toast } = useUI();
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const otherRef = useRef<HTMLInputElement>(null);

  const typedDocs = documents.filter((d) => d.type && d.type !== 'OTHER');
  const otherDocs = documents.filter((d) => !d.type || d.type === 'OTHER');
  const uploadedCount = REQUIRED_DOCUMENTS.filter((r) =>
    typedDocs.some((d) => d.type === r.type),
  ).length;
  const total = REQUIRED_DOCUMENTS.length;
  const percent = Math.round((uploadedCount / total) * 100);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: string) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingType(type);
    try {
      for (const file of files) {
        await uploadDocument(studentId, file, type);
      }
      toast(files.length > 1 ? `Загружено: ${files.length}` : 'Документ загружен', 'success');
      onChange();
    } catch (err: any) {
      toast(err?.response?.data?.message || 'Ошибка загрузки', 'error');
    } finally {
      setUploadingType(null);
      e.target.value = '';
    }
  };

  const handleDownloadZip = async () => {
    if (documents.length === 0 && !applicationForm) return;
    setZipping(true);
    try {
      const [{ default: JSZip }, { saveAs }] = await Promise.all([
        import('jszip'),
        import('file-saver'),
      ]);
      const zip = new JSZip();

      // Сначала — анкета в формате Word (если хоть что-то заполнено или даже пустая)
      if (applicationForm) {
        try {
          const { generateStudentFormDocx } = await import('../utils/studentFormDocx');
          const formBlob = await generateStudentFormDocx(studentName || 'Student', applicationForm);
          zip.file('00_Анкета_Студента.docx', formBlob);
        } catch (err) {
          console.error('Failed to generate form docx:', err);
        }
      }

      // Загружаем типизированные документы (несколько файлов в категории идут с суффиксом _1/_2/...)
      for (let i = 0; i < REQUIRED_DOCUMENTS.length; i++) {
        const req = REQUIRED_DOCUMENTS[i];
        const docs = typedDocs.filter((d) => d.type === req.type);
        if (docs.length === 0) continue;
        for (let j = 0; j < docs.length; j++) {
          const doc = docs[j];
          const res = await fetch(`${API_BASE}${doc.url}`);
          if (!res.ok) continue;
          const blob = await res.blob();
          const ext = doc.originalName.includes('.') ? doc.originalName.split('.').pop() : '';
          const baseName = `${String(i + 1).padStart(2, '0')}_${sanitizeFileName(req.label)}${docs.length > 1 ? `_${j + 1}` : ''}`;
          const fileName = ext ? `${baseName}.${ext}` : baseName;
          zip.file(fileName, blob);
        }
      }

      // Прочие документы — в папке "Прочее"
      if (otherDocs.length > 0) {
        const otherFolder = zip.folder('Прочее');
        for (const doc of otherDocs) {
          const res = await fetch(`${API_BASE}${doc.url}`);
          if (!res.ok) continue;
          const blob = await res.blob();
          otherFolder?.file(sanitizeFileName(doc.originalName), blob);
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const date = new Date().toISOString().slice(0, 10);
      const safeName = sanitizeFileName(studentName || 'student');
      saveAs(blob, `${safeName}_документы_${date}.zip`);
      toast('Архив скачан', 'success');
    } catch (e: any) {
      toast(e?.message || 'Ошибка создания архива', 'error');
    } finally {
      setZipping(false);
    }
  };

  const handleDelete = async (doc: Document) => {
    const ok = await confirm({
      title: 'Удалить документ',
      message: `«${doc.originalName}» будет удалён безвозвратно.`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await deleteDocument(doc.id);
    toast('Документ удалён', 'success');
    onChange();
  };

  return (
    <div className="docs-checklist">
      <div className="docs-info">
        <Icon name="info" size={20} />
        <div>
          Все документы необходимо <b>перевести на английский язык</b> и <b>нотариально заверить</b>.
        </div>
      </div>

      <div className="docs-progress">
        <div className="docs-progress-text">
          <span>Загружено <b>{uploadedCount}</b> из {total}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="docs-progress-percent">{percent}%</span>
            <motion.button
              className="btn btn-sm btn-secondary"
              onClick={handleDownloadZip}
              disabled={zipping || documents.length === 0}
              whileHover={!zipping && documents.length > 0 ? { scale: 1.04 } : {}}
              whileTap={{ scale: 0.96 }}
              title={
                documents.length === 0
                  ? 'Нет документов для скачивания'
                  : 'Скачать все файлы одним архивом'
              }
              style={documents.length === 0 ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            >
              <Icon name={zipping ? 'progress_activity' : 'folder_zip'} size={16} style={{ marginRight: 4 }} />
              {zipping ? 'Архивируем…' : `Скачать ZIP (${documents.length})`}
            </motion.button>
          </div>
        </div>
        <div className="docs-progress-bar">
          <motion.div
            className="docs-progress-fill"
            initial={{ width: 0 }}
            animate={{ width: `${percent}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </div>

      <div className="docs-grid">
        {REQUIRED_DOCUMENTS.map((req) => {
          const docs = typedDocs.filter((d) => d.type === req.type);
          const isUploaded = docs.length > 0;
          const isUploading = uploadingType === req.type;

          return (
            <motion.div
              key={req.type}
              className={`doc-slot${isUploaded ? ' uploaded' : ''}`}
              layout
            >
              <div className="doc-slot-header">
                <div className={`doc-slot-status ${isUploaded ? 'ok' : 'missing'}`}>
                  <Icon name={isUploaded ? 'check_circle' : 'radio_button_unchecked'} size={22} />
                </div>
                <div className="doc-slot-info">
                  <div className="doc-slot-label">
                    {req.label}
                    {docs.length > 1 && <span className="doc-slot-count"> · {docs.length} файла</span>}
                  </div>
                  {req.hint && <div className="doc-slot-hint">{req.hint}</div>}
                </div>
              </div>

              {isUploaded ? (
                <>
                  <div className="doc-slot-files">
                    {docs.map((doc) => (
                      <div key={doc.id} className="doc-slot-file">
                        <a href={`${API_BASE}${doc.url}`} target="_blank" rel="noreferrer" className="doc-slot-filename">
                          <Icon name="description" size={18} />
                          <span>{doc.originalName}</span>
                        </a>
                        <div className="doc-slot-meta">
                          {fmtBytes(doc.size)} · {new Date(doc.createdAt).toLocaleDateString('ru-RU')}
                        </div>
                        {editable && (
                          <button className="btn btn-sm btn-danger doc-slot-del" onClick={() => handleDelete(doc)}>
                            <Icon name="delete" size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {editable && (
                    <button
                      className="btn btn-sm btn-secondary doc-slot-add"
                      onClick={() => inputRefs.current[req.type]?.click()}
                      disabled={isUploading}
                    >
                      <Icon name={isUploading ? 'progress_activity' : 'add'} size={16} style={{ marginRight: 4 }} />
                      {isUploading ? 'Загрузка...' : 'Добавить ещё'}
                    </button>
                  )}
                </>
              ) : editable ? (
                <button
                  className="btn btn-secondary doc-slot-upload"
                  onClick={() => inputRefs.current[req.type]?.click()}
                  disabled={isUploading}
                >
                  <Icon name={isUploading ? 'progress_activity' : 'upload'} size={18} style={{ marginRight: 6 }} />
                  {isUploading ? 'Загрузка...' : 'Загрузить'}
                </button>
              ) : (
                <div className="doc-slot-empty">Не загружено</div>
              )}

              <input
                ref={(el) => { inputRefs.current[req.type] = el; }}
                type="file"
                multiple
                hidden
                onChange={(e) => handleUpload(e, req.type)}
              />
            </motion.div>
          );
        })}
      </div>

      {/* Прочие документы */}
      <div className="docs-other-section">
        <h4 className="docs-other-title">Прочие документы</h4>
        {otherDocs.length === 0 ? (
          <div className="empty" style={{ padding: 16 }}>Прочих документов нет</div>
        ) : (
          <div className="documents-list">
            {otherDocs.map((d) => (
              <div key={d.id} className="doc-item">
                <span className="doc-icon"><Icon name="description" size={20} /></span>
                <div className="doc-info">
                  <div className="doc-name">
                    <a href={`${API_BASE}${d.url}`} target="_blank" rel="noreferrer" style={{ color: 'var(--primary-dark)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                      {d.originalName}
                    </a>
                  </div>
                  <div className="doc-size">{fmtBytes(d.size)} · {new Date(d.createdAt).toLocaleDateString('ru-RU')}</div>
                </div>
                {editable && (
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(d)}>Удалить</button>
                )}
              </div>
            ))}
          </div>
        )}
        {editable && (
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => otherRef.current?.click()}
            >
              <Icon name="attach_file" size={16} style={{ marginRight: 4 }} />
              Загрузить другой документ
            </button>
            <input
              ref={otherRef}
              type="file"
              hidden
              onChange={(e) => handleUpload(e, 'OTHER')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
