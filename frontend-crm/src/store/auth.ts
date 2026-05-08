import { create } from 'zustand';
import type { User } from '../api/types';
import { login as apiLogin, me as apiMe } from '../api/auth';
import { connectRealtime, disconnectRealtime } from '../realtime';

interface AuthState {
  user: User | null;
  initialized: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  init: () => Promise<void>;
}

/**
 * QA-fix: декодим JWT на клиенте, чтобы знать свой id даже когда /auth/me
 * не успел отвечть (cold-start Railway). Без этого `me?.id` был null,
 * и в чате все свои сообщения попадали в ветку `isMine=false` → слева.
 */
function decodeJwt(token: string): { sub?: string; email?: string; role?: string } | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  initialized: false,

  async login(email, password) {
    const { token, user } = await apiLogin(email, password);
    localStorage.setItem('javonon_token', token);
    connectRealtime(token);
    set({ user });
  },

  logout() {
    localStorage.removeItem('javonon_token');
    disconnectRealtime();
    set({ user: null });
  },

  async init() {
    const token = localStorage.getItem('javonon_token');
    if (!token) { set({ initialized: true }); return; }

    // QA-fix: сразу выставляем minimal user из JWT, чтобы UI имел me.id
    // прежде чем /auth/me ответит. Полные данные подтянутся через секунду.
    const claims = decodeJwt(token);
    if (claims?.sub) {
      set({
        user: {
          id: claims.sub,
          email: claims.email || '',
          fullName: '',
          role: (claims.role as any) || 'EMPLOYEE',
        } as User,
        initialized: true,
      });
      connectRealtime(token);
    }

    try {
      const user = await apiMe();
      // Если сервер уточнил/обновил профиль — заменим minimal-user полным.
      connectRealtime(token);
      set({ user, initialized: true });
    } catch (e: any) {
      const status = e?.response?.status;
      // Только 401 = реальный auth-fail (token expired/invalid). На 5xx/network
      // оставляем minimal-user и ждём retry — иначе пользователь разлогинивался
      // на каждом cold-start Railway.
      if (status === 401) {
        localStorage.removeItem('javonon_token');
        set({ user: null, initialized: true });
      } else {
        set({ initialized: true });
      }
    }
  },
}));
