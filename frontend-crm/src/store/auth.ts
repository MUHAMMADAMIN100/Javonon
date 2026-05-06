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
    try {
      const user = await apiMe();
      connectRealtime(token);
      set({ user, initialized: true });
    } catch {
      localStorage.removeItem('javonon_token');
      set({ user: null, initialized: true });
    }
  },
}));
