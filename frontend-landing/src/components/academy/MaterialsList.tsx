import { useState } from 'react';
import Icon from '../../Icon';
import { downloadAcademyMaterial, type AcademyMaterial } from '../../studentApi';
import { fileSize, materialIcon } from './academyBits';

/** Материалы урока: файл — скачать через API, ссылка — открыть. */
export default function MaterialsList({ materials, testPrefix = 'hw-file' }: { materials: AcademyMaterial[]; testPrefix?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (m: { id: string; title: string }) => {
    setBusy(m.id);
    setError(null);
    try {
      await downloadAcademyMaterial(m.id, m.title);
    } catch {
      setError('Файлро боргирӣ кардан нашуд. Бори дигар кӯшиш кунед.');
    } finally {
      setBusy(null);
    }
  };
  if (!materials.length) return null;
  return (
    <div className="acad-cab-materials">
      {error && <div className="acad-cab-error">{error}</div>}
      {materials.map((m) =>
        m.kind === 'LINK' ? (
          <a key={m.id} className="acad-cab-material" href={m.url || '#'} target="_blank" rel="noreferrer">
            <Icon name="link" size={18} />
            <span>{m.title}</span>
            <small>Кушодан</small>
          </a>
        ) : (
          <button
            key={m.id}
            type="button"
            className="acad-cab-material"
            onClick={() => download(m)}
            disabled={busy === m.id}
            data-testid={`${testPrefix}-${m.id}`}
          >
            <Icon name={materialIcon(m.kind, m.mimeType, m.title)} size={18} />
            <span>{m.title}</span>
            <small>{busy === m.id ? 'Боргирӣ…' : `${fileSize(m.size)} · Боргирӣ`}</small>
          </button>
        ),
      )}
    </div>
  );
}
