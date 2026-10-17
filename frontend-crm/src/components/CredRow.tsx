import { useState } from 'react';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/** Строка «подпись: значение [копировать]» в окне с данными для входа. */
export default function CredRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  const { t } = useT();
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
        title={copied ? t('toast.copied') : t('common.copy')}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={15} />
      </button>
    </div>
  );
}
