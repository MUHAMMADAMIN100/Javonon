import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { createStudent } from '../api/students';
import type { Direction } from '../api/types';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { compose, email as emailRule, hasErrors, maxLen, minLen, phoneRule, required, validateAll } from '../utils/validators';
import PhoneInput from '../components/PhoneInput';
import BackButton from '../components/BackButton';
import { keys } from '../lib/queryKeys';
import { useInvalidatingMutation } from '../lib/optimistic';

// Строка-копируемое поле для модалки выдачи доступа.
function CredRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="creds-row">
      <span className="creds-label">{label}:</span>
      <code className="creds-value" style={small ? { fontSize: 12 } : undefined}>{value}</code>
      <button
        type="button"
        onClick={onCopy}
        className="creds-copy-btn"
        title={copied ? 'Скопировано' : 'Скопировать'}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={15} />
      </button>
    </div>
  );
}

export default function StudentNew() {
  const navigate = useNavigate();
  const { toast } = useUI();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneLabel, setPhoneLabel] = useState('сам');
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [secondaryLabel, setSecondaryLabel] = useState('');
  const [preferredChannel, setPreferredChannel] = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail] = useState('');
  const [direction, setDirection] = useState<Direction>('BACHELOR');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<
    | { id: string; email: string; password: string; fullName: string }
    | null
  >(null);

  const errors = validateAll(
    { fullName, phone, email, comment },
    {
      fullName: compose(required('Введите ФИО'), minLen(2), maxLen(100)),
      phone: phoneRule(),
      email: compose(required('Введите email'), emailRule()),
      comment: maxLen(1000),
    },
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const showErr = (k: keyof typeof errors) => touched[k] && errors[k];
  const isInvalid = hasErrors(errors);

  const createMut = useInvalidatingMutation({
    mutationFn: createStudent,
    invalidate: [keys.students.all, keys.applications.all],
    onSuccess: (res: any) => {
      setCredentials({
        id: res.id,
        email: res.email,
        password: res.plainPassword,
        fullName: res.fullName,
      });
    },
    onError: (e: any) => setError(e.response?.data?.message?.toString() || 'Ошибка создания'),
  });
  const submitting = createMut.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ fullName: true, phone: true, email: true, comment: true });
    if (isInvalid) return;
    setError(null);
    // Собираем телефоны и подписи синхронно по индексу — backend ожидает
    // одинаковую длину массивов.
    const phones: string[] = [];
    const phoneLabels: string[] = [];
    if (phone) {
      phones.push(phone);
      phoneLabels.push(phoneLabel.trim() || 'сам');
    }
    if (secondaryPhone) {
      phones.push(secondaryPhone);
      phoneLabels.push(secondaryLabel.trim());
    }

    createMut.mutate({
      fullName,
      phones,
      phoneLabels,
      preferredChannel: (preferredChannel || undefined) as any,
      birthday: birthday || undefined,
      email,
      direction,
      comment: comment || undefined,
    } as any);
  };

  const copyBoth = async () => {
    if (!credentials) return;
    const text = `Логин: ${credentials.email}\nПароль: ${credentials.password}\nВход: https://javonon.vercel.app/login`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Данные скопированы', 'success');
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <BackButton fallback="/students" />
      <div className="card">
      <div className="card-header"><h2 className="card-title">Новый студент</h2></div>
      <div className="card-body">
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>ФИО *</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
              className={showErr('fullName') ? 'input-error' : ''}
              maxLength={100}
              required
            />
            {showErr('fullName') && <div className="form-error-text">{errors.fullName}</div>}
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>Основной телефон</label>
              <PhoneInput
                value={phone}
                onChange={(v) => setPhone(v)}
                error={!!showErr('phone')}
              />
              {showErr('phone') && <div className="form-error-text">{errors.phone}</div>}
            </div>
            <div className="form-group">
              <label>Подпись основного <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— чей номер</span></label>
              <input
                value={phoneLabel}
                onChange={(e) => setPhoneLabel(e.target.value)}
                placeholder="сам"
                maxLength={40}
              />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>Доп. телефон <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— мать/отец/др.</span></label>
              <PhoneInput
                value={secondaryPhone}
                onChange={(v) => setSecondaryPhone(v)}
              />
            </div>
            <div className="form-group">
              <label>Подпись доп. контакта</label>
              <input
                value={secondaryLabel}
                onChange={(e) => setSecondaryLabel(e.target.value)}
                placeholder="Отец, Мать..."
                maxLength={40}
              />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>Предпочтительный канал связи</label>
              <select value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value)}>
                <option value="">—</option>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="PHONE">Телефон</option>
                <option value="INSTAGRAM">Instagram</option>
                <option value="TELEGRAM">Telegram</option>
                <option value="EMAIL">Email</option>
              </select>
            </div>
            <div className="form-group">
              <label>Дата рождения <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— для авто-поздравлений</span></label>
              <input
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Email * <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— станет логином студента</span></label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              className={showErr('email') ? 'input-error' : ''}
              required
            />
            {showErr('email') && <div className="form-error-text">{errors.email}</div>}
          </div>
          <div className="form-group">
            <label>Направление *</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="BACHELOR">Бакалавриат → каб. 1</option>
              <option value="MASTER">Магистратура → каб. 2</option>
              <option value="LANGUAGE">Языковые курсы → каб. 3</option>
              <option value="LANGUAGE_COLLEGE">Языковой + колледж → каб. 4</option>
              <option value="LANGUAGE_BACHELOR">Языковой + бакалавриат → каб. 5</option>
              <option value="COLLEGE">Колледж → каб. 6</option>
            </select>
          </div>
          <div className="form-group">
            <label>Комментарий <span style={{ fontWeight: 400, color: 'var(--text-soft)', fontSize: 12 }}>— до 1000 символов</span></label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={1000}
              className={showErr('comment') ? 'input-error' : ''}
            />
            {showErr('comment') && <div className="form-error-text">{errors.comment}</div>}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/students')}>Отмена</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || isInvalid}
              title={isInvalid ? 'Исправьте ошибки в форме' : ''}
            >
              {submitting ? 'Создаём...' : 'Создать'}
            </button>
          </div>
        </form>
      </div>

      <AnimatePresence>
        {credentials && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="dialog-card"
              style={{ maxWidth: 480 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.22 }}
            >
              <div className="dialog-icon" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                <Icon name="check_circle" size={28} />
              </div>
              <div className="dialog-title">Студент создан</div>
              <div className="dialog-message">
                Передайте эти данные <b>{credentials.fullName}</b> — это единственный раз, когда система показывает пароль.
              </div>

              <div className="creds-box">
                <CredRow label="Логин" value={credentials.email} />
                <CredRow label="Пароль" value={credentials.password} />
                <CredRow label="Ссылка" value="javonon.vercel.app/login" small />
              </div>

              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={copyBoth}>
                  <Icon name="content_copy" size={16} style={{ marginRight: 4 }} />
                  Копировать
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => navigate(`/students/${credentials.id}`)}
                >
                  Открыть карточку
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
