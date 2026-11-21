import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { removeAvatar, uploadAvatar } from '../api/users';
import { AVATAR_ACCEPT, AvatarFileError, cropAvatar } from '../lib/avatarCrop';
import { AvatarFace } from './AvatarFace';
import { heroColor, heroInitials } from './ProfileParts';

/**
 * Аватарка в шапке профиля сотрудника (21.11.2026). Можно править — снизу
 * справа кнопка-камера (как у студента): без фото сразу выбор файла, с фото —
 * меню «Сменить фото / Удалить фото». Фото обрезается квадратом в браузере
 * (lib/avatarCrop), права проверяет сервер (/me/avatar/:id).
 */
export default function ProfileAvatar({ userId, name, url, canEdit, queryKey }: {
  userId: string;
  name: string;
  url?: string | null;
  canEdit: boolean;
  /** Ключ запроса профиля — перечитать после смены фото. */
  queryKey: unknown[];
}) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);

  // Меню закрывается кликом мимо и Esc.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const applied = async (avatarUrl: string | null) => {
    // Своё фото — сразу в меню внизу и в меню пользователя (они читают store).
    if (me && me.id === userId) useAuth.setState({ user: { ...me, avatarUrl } });
    await Promise.all([
      qc.invalidateQueries({ queryKey }),
      qc.invalidateQueries({ queryKey: ['users'] }),
      qc.invalidateQueries({ queryKey: ['kpi'] }),
      qc.invalidateQueries({ queryKey: ['chat'] }),
    ]).catch(() => undefined);
  };

  const onPick = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const blob = await cropAvatar(file);
      const res = await uploadAvatar(userId, blob);
      await applied(res.avatarUrl);
      toast(t('profile.avatar.saved'), 'success');
    } catch (e: any) {
      const msg = e instanceof AvatarFileError ? t(`profile.avatar.${e.message}`) : e?.response?.data?.message;
      toast(msg || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setMenu(false);
    const ok = await confirm({ title: t('profile.avatar.remove') + '?', message: t('profile.avatar.removeConfirm'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    setBusy(true);
    try {
      await removeAvatar(userId);
      await applied(null);
      toast(t('profile.avatar.removed'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const camTitle = url ? t('profile.avatar.change') : t('profile.avatar.upload');
  return (
    <div className="client-avatar profile-avatar-box" ref={boxRef}>
      <span
        className={`profile-hero-avatar${url ? ' has-photo' : ''}`}
        style={url ? undefined : { background: heroColor(userId) }}
        data-testid="profile-avatar"
        aria-hidden="true"
      >
        <AvatarFace url={url} initials={heroInitials(name)} />
      </span>
      {canEdit && (
        <>
          <button
            type="button"
            className="client-avatar-cam"
            onClick={() => (url ? setMenu((v) => !v) : fileRef.current?.click())}
            disabled={busy}
            title={camTitle}
            aria-label={camTitle}
            aria-haspopup={url ? 'menu' : undefined}
            aria-expanded={url ? menu : undefined}
            data-testid="profile-avatar-btn"
          >
            <Icon name={busy ? 'progress_activity' : 'photo_camera'} size={16} />
          </button>
          {menu && (
            <div className="profile-avatar-menu" role="menu" data-testid="profile-avatar-menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); fileRef.current?.click(); }} data-testid="profile-avatar-change">
                <Icon name="photo_camera" size={17} /> {t('profile.avatar.change')}
              </button>
              <button type="button" role="menuitem" className="is-danger" onClick={onRemove} data-testid="profile-avatar-remove">
                <Icon name="delete" size={17} /> {t('profile.avatar.remove')}
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_ACCEPT}
            hidden
            onChange={(e) => onPick(e.target.files?.[0])}
            data-testid="profile-avatar-input"
          />
        </>
      )}
    </div>
  );
}
