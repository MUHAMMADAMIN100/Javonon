import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUI } from '../ui/Dialogs';
import {
  createSubmission,
  uploadSubmissionFile,
  type CreateSubmissionDto,
  type SubmissionPaymentMethod,
} from '../api/submissions';
import { listStudents } from '../api/students';
import { listPrograms } from '../api/programs';
import Icon from '../Icon';
import CrmDatePicker from '../components/CrmDatePicker';

type Mode = 'existing' | 'new';

// Метаданные загруженного файла из /submissions/upload — нужны бэку,
// чтобы при APPROVE создать Document с правильным mime/size/originalName.
type UploadMeta = { mime: string; size: number; originalName: string };

export default function SubmissionForm() {
  const navigate = useNavigate();
  const { toast } = useUI();

  // Студент
  const [mode, setMode] = useState<Mode>('existing');
  const [studentId, setStudentId] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  // BUG #16: debounce 300ms — иначе на каждый keystroke летит запрос
  // findMany с полным include, что вешает сервер на 1000+ студентов.
  const [debouncedStudentSearch, setDebouncedStudentSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedStudentSearch(studentSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [studentSearch]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  // Массивы файлов паспорта (unlimited). Метаданные идут параллельным массивом
  // той же длины — при APPROVE бэк сопоставляет их по индексу для Document.
  const [passportUrls, setPassportUrls] = useState<string[]>([]);
  const [passportMetas, setPassportMetas] = useState<UploadMeta[]>([]);

  // Программа + контракт
  const [programId, setProgramId] = useState('');
  const [contractUrls, setContractUrls] = useState<string[]>([]);
  const [contractMetas, setContractMetas] = useState<UploadMeta[]>([]);
  const [totalAmount, setTotalAmount] = useState('');
  const [currency, setCurrency] = useState('TJS');
  const [notes, setNotes] = useState('');

  // Первый платёж
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<SubmissionPaymentMethod>('TRANSFER');
  const [payDate, setPayDate] = useState(() => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  });
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);
  const [receiptMetas, setReceiptMetas] = useState<UploadMeta[]>([]);
  const [depositProofUrls, setDepositProofUrls] = useState<string[]>([]);
  const [depositProofMetas, setDepositProofMetas] = useState<UploadMeta[]>([]);
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueAmount, setNextDueAmount] = useState('');

  // Счётчик активных загрузок файлов (защита от submit во время upload)
  const [pendingUploads, setPendingUploads] = useState(0);
  const onUploadingChange = (isUploading: boolean) => {
    setPendingUploads((n) => Math.max(0, n + (isUploading ? 1 : -1)));
  };

  // BUG #16: enabled только при >= 2 символах + limit=50 — иначе на
  // 1000+ студентов findMany с полным include вешает и сервер, и браузер.
  const studentsQuery = useQuery({
    queryKey: ['students-search', debouncedStudentSearch],
    queryFn: () =>
      listStudents({ search: debouncedStudentSearch, limit: 50 }),
    enabled: mode === 'existing' && debouncedStudentSearch.length >= 2,
  });
  const studentOptions = studentsQuery.data || [];
  const selectedStudent = studentOptions.find((s) => s.id === studentId);
  const programsQuery = useQuery({
    queryKey: ['programs-all'],
    queryFn: () => listPrograms(),
  });

  const createMut = useMutation({
    mutationFn: (data: CreateSubmissionDto) => createSubmission(data),
    onSuccess: (s) => {
      toast('Сделка отправлена на одобрение', 'success');
      navigate(`/submissions/${s.id}`);
    },
    // Порядок фоллбеков:
    //   response.data.message  — читаемая ошибка от Nest (BadRequest, Forbidden)
    //   response.status===403  — недостаточно прав (RolesGuard)
    //   userMessage            — network/timeout из interceptor'а client.ts
    //   generic                — «Ошибка отправки»
    onError: (e: any) => {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        (status === 403 ? 'Недостаточно прав для создания сделки' : null) ||
        (status === 413 ? 'Файл слишком большой' : null) ||
        e?.userMessage ||
        'Не удалось отправить сделку. Попробуйте ещё раз.';
      toast(msg, 'error');
    },
  });

  const onSubmit = () => {
    // Валидация
    if (pendingUploads > 0) return toast('Дождитесь загрузки файлов', 'error');
    if (mode === 'existing' && !studentId) return toast('Выберите студента', 'error');
    if (mode === 'new' && newName.trim().length < 2) return toast('ФИО студента (мин 2 символа)', 'error');
    if (!programId) return toast('Выберите программу', 'error');
    if (contractUrls.length === 0) return toast('Загрузите хотя бы 1 файл контракта', 'error');
    const ta = parseFloat(totalAmount);
    if (!isFinite(ta) || ta <= 0) return toast('Сумма контракта должна быть > 0', 'error');
    const pa = parseFloat(payAmount);
    if (!isFinite(pa) || pa <= 0) return toast('Сумма платежа должна быть > 0', 'error');
    if (payMethod === 'TRANSFER' && receiptUrls.length === 0) return toast('Прикрепите чек перевода', 'error');
    if (payMethod === 'CASH' && depositProofUrls.length === 0) return toast('Прикрепите скрин пополнения счёта', 'error');

    createMut.mutate({
      studentId: mode === 'existing' ? studentId : null,
      newStudentName: mode === 'new' ? newName.trim() : undefined,
      newStudentPhone: mode === 'new' ? newPhone.trim() : undefined,
      newStudentEmail: mode === 'new' ? newEmail.trim() : undefined,
      // Массивы паспорта (только для нового студента). Бэк сохранит их
      // на SaleSubmission и подставит в Document'ы при APPROVE.
      newStudentPassportUrls: mode === 'new' && passportUrls.length > 0 ? passportUrls : undefined,
      newStudentPassportMimes: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.mime) : undefined,
      newStudentPassportSizes: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.size) : undefined,
      newStudentPassportOriginalNames: mode === 'new' && passportUrls.length > 0
        ? passportMetas.map((m) => m.originalName) : undefined,
      programId,
      contractUrls,
      contractMimes: contractMetas.map((m) => m.mime),
      contractSizes: contractMetas.map((m) => m.size),
      contractOriginalNames: contractMetas.map((m) => m.originalName),
      totalAmount: ta,
      currency,
      notes: notes.trim() || undefined,
      firstPayment: {
        amount: pa,
        paymentMethod: payMethod,
        paidAt: payDate,
        receiptUrls: receiptUrls.length > 0 ? receiptUrls : undefined,
        depositProofUrls: depositProofUrls.length > 0 ? depositProofUrls : undefined,
        nextDueDate: nextDueDate || null,
        nextDueAmount: nextDueAmount ? parseFloat(nextDueAmount) : null,
      },
    });
  };

  const saving = createMut.isPending;

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">SALES · NEW</span>
        <h2 className="crm-section-title">Новая сделка</h2>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 24 }}
      >
        {/* ===== 1. СТУДЕНТ ===== */}
        <Section title="1. Студент">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('existing')}
            >
              Существующий
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('new')}
            >
              Новый
            </button>
          </div>

          {mode === 'existing' && (
            // BUG #16: typeahead вместо select с 1000+ option. Список
            // подсказок появляется только когда введено >= 2 символа.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
              {selectedStudent ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="crm-input" style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                    <strong>{selectedStudent.fullName}</strong>
                    {selectedStudent.phones?.[0] ? (
                      <span style={{ marginLeft: 8, color: 'var(--text-soft)' }}>
                        · {selectedStudent.phones[0]}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      setStudentId('');
                      setStudentSearch('');
                    }}
                  >
                    Сменить
                  </button>
                </div>
              ) : (
                <>
                  <input
                    className="crm-input"
                    placeholder="Поиск студента по ФИО / телефону / email (мин. 2 символа)"
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                  />
                  {debouncedStudentSearch.length < 2 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                      Введите минимум 2 символа для поиска
                    </div>
                  ) : studentsQuery.isLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>Поиск…</div>
                  ) : studentOptions.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>Ничего не найдено</div>
                  ) : (
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        maxHeight: 240,
                        overflowY: 'auto',
                        border: '1px solid var(--border-soft, #e5e7eb)',
                        borderRadius: 6,
                      }}
                    >
                      {studentOptions.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setStudentId(s.id)}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 10px',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border-soft, #f1f5f9)',
                            }}
                          >
                            <strong>{s.fullName}</strong>
                            {s.phones?.[0] ? (
                              <span style={{ marginLeft: 8, color: 'var(--text-soft)' }}>
                                · {s.phones[0]}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                      {studentOptions.length >= 50 && (
                        <li style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)' }}>
                          Показаны первые 50 — уточните запрос
                        </li>
                      )}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'new' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <Field label="ФИО *">
                <input className="crm-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Иванов Иван" />
              </Field>
              <Field label="Телефон">
                <input className="crm-input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+992..." />
              </Field>
              <Field label="Email">
                <input className="crm-input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@example.com" />
              </Field>
              <Field label="Паспорт (фото/PDF)">
                <MultiFileUpload
                  values={passportUrls}
                  metas={passportMetas}
                  onChange={(u, m) => { setPassportUrls(u); setPassportMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            </div>
          )}
        </Section>

        {/* ===== 2. ПРОГРАММА + КОНТРАКТ ===== */}
        <Section title="2. Программа и контракт">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Field label="Программа *">
              <select className="crm-select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
                <option value="">— выберите —</option>
                {(programsQuery.data || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.university})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Контракт (PDF/фото) *">
              <MultiFileUpload
                values={contractUrls}
                metas={contractMetas}
                onChange={(u, m) => { setContractUrls(u); setContractMetas(m); }}
                accept="image/*,application/pdf"
                onUploadingChange={onUploadingChange}
              />
            </Field>
            <Field label="Сумма контракта *">
              <input className="crm-input" type="number" min={0} step={50} value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} placeholder="3000" />
            </Field>
            <Field label="Валюта">
              <select className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="TJS">TJS (сомони)</option>
                <option value="USD">USD</option>
              </select>
            </Field>
          </div>
        </Section>

        {/* ===== 3. ПЕРВЫЙ ПЛАТЁЖ ===== */}
        <Section title="3. Первый платёж">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Field label="Сумма *">
              <input className="crm-input" type="number" min={0} step={50} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="1000" />
            </Field>
            <Field label="Метод *">
              <select className="crm-select" value={payMethod} onChange={(e) => setPayMethod(e.target.value as SubmissionPaymentMethod)}>
                <option value="TRANSFER">Перевод</option>
                <option value="CASH">Наличные</option>
                <option value="OTHER">Прочее</option>
              </select>
            </Field>
            <Field label="Дата оплаты *">
              <CrmDatePicker value={payDate} onChange={setPayDate} />
            </Field>
            {payMethod === 'TRANSFER' && (
              <Field label="Чек / скрин перевода *">
                <MultiFileUpload
                  values={receiptUrls}
                  metas={receiptMetas}
                  onChange={(u, m) => { setReceiptUrls(u); setReceiptMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            {payMethod === 'CASH' && (
              <Field label="Скрин пополнения счёта *">
                <MultiFileUpload
                  values={depositProofUrls}
                  metas={depositProofMetas}
                  onChange={(u, m) => { setDepositProofUrls(u); setDepositProofMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            {payMethod === 'OTHER' && (
              <Field label="Подтверждение">
                <MultiFileUpload
                  values={receiptUrls}
                  metas={receiptMetas}
                  onChange={(u, m) => { setReceiptUrls(u); setReceiptMetas(m); }}
                  accept="image/*,application/pdf"
                  onUploadingChange={onUploadingChange}
                />
              </Field>
            )}
            <Field label="Следующий платёж: дата">
              <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} />
            </Field>
            <Field label="Следующий платёж: сумма">
              <input className="crm-input" type="number" min={0} step={50} value={nextDueAmount} onChange={(e) => setNextDueAmount(e.target.value)} placeholder="2000" />
            </Field>
          </div>
        </Section>

        <Section title="Комментарий">
          <textarea
            className="crm-textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Любые пояснения для основателя"
            style={{ resize: 'none' }}
          />
        </Section>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => navigate('/submissions')} disabled={saving}>
            Отмена
          </button>
          {/* BUG-fix: раньше кнопка была `disabled` при pendingUploads>0. Если
              FileUpload размонтировался в середине загрузки (например, менеджер
              переключил payMethod TRANSFER→CASH до окончания upload'а),
              onUploadingChange(false) не вызывался и счётчик оставался >0 —
              кнопка навсегда серая без объяснения. Теперь клик всегда доходит
              до onSubmit, а тот покажет внятный toast если загрузка ещё идёт. */}
          <button className="btn btn-primary" onClick={onSubmit} disabled={saving}>
            {saving ? 'Отправляем…' : pendingUploads > 0 ? 'Загружаем файлы…' : 'Отправить на одобрение'}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--primary-dark)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// Мульти-файловый uploader. Поддерживает:
//   1) выбор нескольких файлов за раз (input multiple)
//   2) итеративное добавление через кнопку «+ Добавить ещё»
//   3) удаление по одному через × рядом с каждой строкой
// Лимитов на количество нет; ограничение на размер (50MB/файл) — на бэке
// (multer в submissions.controller.ts:upload). Пока идёт batch upload,
// компонент держит один тик pendingUploads (родитель считает активные
// загрузки и блокирует сабмит). На unmount тик возвращается в 0.
function MultiFileUpload({
  values,
  metas,
  onChange,
  accept,
  onUploadingChange,
}: {
  values: string[];
  metas: UploadMeta[];
  onChange: (urls: string[], metas: UploadMeta[]) => void;
  accept?: string;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  // Держит ли компонент активный тик pendingUploads. На unmount возвращаем
  // тик в 0 (иначе счётчик застрянет и кнопка сабмита будет вечно «Загружаем…»).
  const uploadingRef = useRef(false);
  useEffect(() => {
    return () => {
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setUploading(true);
    if (!uploadingRef.current) {
      uploadingRef.current = true;
      onUploadingChange?.(true);
    }
    const newUrls: string[] = [];
    const newMetas: UploadMeta[] = [];
    let failed = 0;
    try {
      for (const file of files) {
        try {
          const r = await uploadSubmissionFile(file);
          newUrls.push(r.url);
          // Предпочитаем mimeType с сервера (submissions.controller.ts:upload
          // возвращает file.mimetype после multer-валидации). Фоллбек — file.type
          // из браузера; для file.type=='' (редкий .heic в старых браузерах)
          // подставляем octet-stream.
          newMetas.push({
            mime: r.mimeType || file.type || 'application/octet-stream',
            size: r.size ?? file.size,
            originalName: r.originalName || file.name,
          });
        } catch (e: any) {
          failed++;
          toast(e?.response?.data?.message || e?.userMessage || `Ошибка загрузки: ${file.name}`, 'error');
        }
      }
      if (newUrls.length > 0) {
        onChange([...values, ...newUrls], [...metas, ...newMetas]);
        if (failed === 0) toast(`Загружено файлов: ${newUrls.length}`, 'success');
      }
    } finally {
      setUploading(false);
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
      // Сбрасываем value у input'ов чтобы можно было выбрать те же файлы
      // повторно (иначе onChange не сработает на идентичный FileList).
      if (inputRef.current) inputRef.current.value = '';
      if (addInputRef.current) addInputRef.current.value = '';
    }
  };

  const removeAt = (idx: number) => {
    const nextUrls = values.filter((_, i) => i !== idx);
    const nextMetas = metas.filter((_, i) => i !== idx);
    onChange(nextUrls, nextMetas);
  };

  const isImage = (url: string, mime?: string) => {
    if (mime && mime.startsWith('image/')) return true;
    return /\.(jpg|jpeg|png|webp|heic|gif|bmp)$/i.test(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {values.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {values.map((url, i) => {
            const meta = metas[i];
            const img = isImage(url, meta?.mime);
            return (
              <li
                key={`${url}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  border: '1px solid var(--border-soft, #e5e7eb)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {img ? (
                  <img
                    src={url}
                    alt=""
                    style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                  />
                ) : (
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--surface-2, #f1f5f9)',
                      borderRadius: 4,
                      flexShrink: 0,
                      color: 'var(--primary-dark)',
                    }}
                  >
                    <Icon name="picture_as_pdf" size={18} />
                  </span>
                )}
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-soft)',
                  }}
                  title={meta?.originalName || url}
                >
                  {meta?.originalName || url.split('/').pop()}
                </span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  disabled={uploading}
                  aria-label="Удалить файл"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    color: 'var(--danger, #dc2626)',
                    fontSize: 16,
                    lineHeight: 1,
                    padding: '2px 6px',
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={(e) => handleFiles(e.target.files)}
        disabled={uploading}
        style={{ fontSize: 13 }}
      />
      {/* Скрытый input для повторного добавления батча — доступ через кнопку. */}
      <input
        ref={addInputRef}
        type="file"
        multiple
        accept={accept}
        onChange={(e) => handleFiles(e.target.files)}
        disabled={uploading}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => addInputRef.current?.click()}
          disabled={uploading}
        >
          + Добавить ещё
        </button>
        {uploading && <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>Загружаем…</span>}
        {!uploading && values.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--primary-dark)' }}>
            <Icon name="check_circle" size={14} /> Файлов: {values.length}
          </span>
        )}
      </div>
    </div>
  );
}

// Компонент одиночной загрузки — оставлен для обратной совместимости
// с другими экранами (не удалять). В этой форме больше не используется:
// все поля переведены на MultiFileUpload.
function FileUpload({
  value,
  onChange,
  onMetaChange,
  onUploadingChange,
}: {
  value: string;
  onChange: (v: string) => void;
  // Возвращаем mime/size/originalName наверх, чтобы родитель отправил
  // их вместе с createSubmission — иначе Document при APPROVE сохранится
  // с плейсхолдерами (octet-stream / size=0 / originalName='passport').
  onMetaChange?: (meta: UploadMeta | null) => void;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  // Хранит, «отдали» ли мы наверх активный тик pendingUploads. Нужно чтобы:
  // (а) если компонент размонтируется во время загрузки (например, менеджер
  //     переключил payMethod TRANSFER→CASH и FileUpload с чеком исчез) — на
  //     unmount вернуть счётчик в 0; иначе кнопка submit останется disabled.
  // (б) не декрементить дважды, если finally уже отработал.
  const uploadingRef = useRef(false);
  useEffect(() => {
    return () => {
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    uploadingRef.current = true;
    onUploadingChange?.(true);
    try {
      const r = await uploadSubmissionFile(file);
      onChange(r.url);
      // Предпочитаем mimeType с сервера (submissions.controller.ts:upload
      // теперь возвращает file.mimetype). Фоллбек — file.type из браузера;
      // для file.type=='' (редкий случай для .heic в старых браузерах)
      // подставляем octet-stream.
      onMetaChange?.({
        mime: r.mimeType || file.type || 'application/octet-stream',
        size: r.size ?? file.size,
        originalName: r.originalName || file.name,
      });
      toast('Файл загружен', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || e?.userMessage || 'Ошибка загрузки', 'error');
    } finally {
      setUploading(false);
      if (uploadingRef.current) {
        uploadingRef.current = false;
        onUploadingChange?.(false);
      }
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        type="file"
        accept="image/*,application/pdf"
        onChange={(e) => handleFile(e.target.files?.[0] || null)}
        disabled={uploading}
        style={{ fontSize: 13 }}
      />
      {uploading && <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>Загружаем…</span>}
      {value && !uploading && (
        <span style={{ fontSize: 12, color: 'var(--primary-dark)' }}>
          <Icon name="check_circle" size={14} /> Загружено
        </span>
      )}
    </div>
  );
}
