import { useState } from 'react';
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

export default function SubmissionForm() {
  const navigate = useNavigate();
  const { toast } = useUI();

  // Студент
  const [mode, setMode] = useState<Mode>('existing');
  const [studentId, setStudentId] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [passportUrl, setPassportUrl] = useState('');

  // Программа + контракт
  const [programId, setProgramId] = useState('');
  const [contractUrl, setContractUrl] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');

  // Первый платёж
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<SubmissionPaymentMethod>('TRANSFER');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [receiptUrl, setReceiptUrl] = useState('');
  const [depositProofUrl, setDepositProofUrl] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueAmount, setNextDueAmount] = useState('');

  const studentsQuery = useQuery({
    queryKey: ['students-search', studentSearch],
    queryFn: () => listStudents({ search: studentSearch || undefined }),
    enabled: mode === 'existing',
  });
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
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onSubmit = () => {
    // Валидация
    if (mode === 'existing' && !studentId) return toast('Выберите студента', 'error');
    if (mode === 'new' && newName.trim().length < 2) return toast('ФИО студента (мин 2 символа)', 'error');
    if (!programId) return toast('Выберите программу', 'error');
    if (!contractUrl) return toast('Загрузите контракт', 'error');
    const ta = parseFloat(totalAmount);
    if (!isFinite(ta) || ta <= 0) return toast('Сумма контракта должна быть > 0', 'error');
    const pa = parseFloat(payAmount);
    if (!isFinite(pa) || pa <= 0) return toast('Сумма платежа должна быть > 0', 'error');
    if (payMethod === 'TRANSFER' && !receiptUrl) return toast('Прикрепите чек перевода', 'error');
    if (payMethod === 'CASH' && !depositProofUrl) return toast('Прикрепите скрин пополнения счёта', 'error');

    createMut.mutate({
      studentId: mode === 'existing' ? studentId : null,
      newStudentName: mode === 'new' ? newName.trim() : undefined,
      newStudentPhone: mode === 'new' ? newPhone.trim() : undefined,
      newStudentEmail: mode === 'new' ? newEmail.trim() : undefined,
      newStudentPassportUrl: mode === 'new' ? passportUrl || undefined : undefined,
      programId,
      contractUrl,
      totalAmount: ta,
      currency,
      notes: notes.trim() || undefined,
      firstPayment: {
        amount: pa,
        paymentMethod: payMethod,
        paidAt: payDate,
        receiptUrl: receiptUrl || undefined,
        depositProofUrl: depositProofUrl || undefined,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                className="crm-input"
                placeholder="Поиск студента по ФИО / телефону / email"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
              />
              <select className="crm-select" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                <option value="">— выберите —</option>
                {(studentsQuery.data || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} {s.phones?.[0] ? `· ${s.phones[0]}` : ''}
                  </option>
                ))}
              </select>
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
                <FileUpload value={passportUrl} onChange={setPassportUrl} />
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
              <FileUpload value={contractUrl} onChange={setContractUrl} />
            </Field>
            <Field label="Сумма контракта *">
              <input className="crm-input" type="number" min={0} step={50} value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} placeholder="3000" />
            </Field>
            <Field label="Валюта">
              <select className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="USD">USD</option>
                <option value="TJS">TJS</option>
                <option value="CNY">CNY</option>
                <option value="RUB">RUB</option>
                <option value="EUR">EUR</option>
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
                <FileUpload value={receiptUrl} onChange={setReceiptUrl} />
              </Field>
            )}
            {payMethod === 'CASH' && (
              <Field label="Скрин пополнения счёта *">
                <FileUpload value={depositProofUrl} onChange={setDepositProofUrl} />
              </Field>
            )}
            {payMethod === 'OTHER' && (
              <Field label="Подтверждение">
                <FileUpload value={receiptUrl} onChange={setReceiptUrl} />
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
          <button className="btn btn-primary" onClick={onSubmit} disabled={saving}>
            {saving ? 'Отправляем…' : 'Отправить на одобрение'}
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

function FileUpload({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadSubmissionFile(file);
      onChange(r.url);
      toast('Файл загружен', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка загрузки', 'error');
    } finally {
      setUploading(false);
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
