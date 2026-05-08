import { io, Socket } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
const SOCKET_URL = API_URL.replace(/\/api$/, '');

let socket: Socket | null = null;
let currentToken: string | null = null;
// idle/connecting/connected — баннер скрыт. disconnected/reconnecting — показан.
type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
let connState: ConnState = 'idle';
const stateListeners: ((s: ConnState) => void)[] = [];

const setState = (s: ConnState) => {
  if (connState === s) return;
  connState = s;
  stateListeners.forEach((cb) => cb(s));
};

// Grace period 3 сек на самовосстановление, прежде чем показать баннер.
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
const clearDisconnectTimer = () => {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
};

export function connectStudentRealtime(token: string) {
  try {
    if (socket && currentToken === token && socket.connected) {
      setState('connected');
      return socket;
    }
    if (socket) socket.disconnect();
    currentToken = token;
    setState('connecting');
    socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
    socket.on('connect', () => {
      clearDisconnectTimer();
      setState('connected');
    });
    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return;
      clearDisconnectTimer();
      disconnectTimer = setTimeout(() => {
        if (!socket?.connected) setState('disconnected');
      }, 3000);
    });
    socket.io.on('reconnect_attempt', () => {
      clearDisconnectTimer();
      if (connState === 'disconnected') setState('reconnecting');
    });
    socket.io.on('reconnect', () => {
      clearDisconnectTimer();
      setState('connected');
    });
    return socket;
  } catch (err) {
    console.error('[realtime] connect failed:', err);
    setState('disconnected');
    return null;
  }
}

/** React hook: отдаёт текущее состояние соединения и подписывается на изменения. */
export function useRealtimeConnState(): ConnState {
  const [state, setLocal] = useState<ConnState>(connState);
  useEffect(() => {
    const cb = (s: ConnState) => setLocal(s);
    stateListeners.push(cb);
    return () => {
      const i = stateListeners.indexOf(cb);
      if (i >= 0) stateListeners.splice(i, 1);
    };
  }, []);
  return state;
}

/** UI-хук: показывать ли баннер. true только при реальной потере связи. */
export function useShouldShowOfflineBanner(): { show: boolean; state: ConnState } {
  const state = useRealtimeConnState();
  return {
    show: state === 'disconnected' || state === 'reconnecting',
    state,
  };
}

export function disconnectStudentRealtime() {
  clearDisconnectTimer();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentToken = null;
  setState('idle');
}

export function getSocket() {
  return socket;
}

export function useStudentRealtime(handlers: Record<string, (...args: any[]) => void>) {
  // handlers держим в ref чтобы не пересоздавать подписки при каждом рендере,
  // но всегда вызывать актуальные коллбэки.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const events = Object.keys(handlersRef.current);
    const wrapped = events.map((ev) => {
      const cb = (...args: any[]) => handlersRef.current[ev]?.(...args);
      s.on(ev, cb);
      return [ev, cb] as const;
    });
    return () => {
      wrapped.forEach(([ev, cb]) => s.off(ev, cb));
    };
  }, []);
}
