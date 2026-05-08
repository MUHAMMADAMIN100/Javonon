import { io, Socket } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
const SOCKET_URL = API_URL.replace(/\/api$/, '');

let socket: Socket | null = null;
let currentToken: string | null = null;
// 'idle' — ещё ни разу не пытались подключиться (баннер не показываем).
// 'connecting' — попытка подключения, < grace period (баннер не показываем).
// 'connected' — всё ок (баннер не показываем).
// 'disconnected' — реально оборвалось после grace period (показываем баннер).
// 'reconnecting' — переподключаемся (показываем мягкий баннер).
type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
let connState: ConnState = 'idle';
const stateListeners: ((s: ConnState) => void)[] = [];
const setState = (s: ConnState) => {
  if (connState === s) return;
  connState = s;
  stateListeners.forEach((cb) => cb(s));
};

// Защита от ложных миганий баннера: между disconnect и реальным показом
// баннера держим окно в 3 сек, чтобы socket.io успел переподключиться сам.
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
const clearDisconnectTimer = () => {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
};

export function connectRealtime(token: string) {
  try {
    // Если уже подключены тем же токеном — не пересоздавать (StrictMode-safe).
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
      // 'io client disconnect' = пользователь вышел сам (logout) — не показываем баннер.
      if (reason === 'io client disconnect') return;
      clearDisconnectTimer();
      // Даём 3 сек на самовосстановление, прежде чем тревожить пользователя.
      disconnectTimer = setTimeout(() => {
        if (!socket?.connected) setState('disconnected');
      }, 3000);
    });
    socket.io.on('reconnect_attempt', () => {
      clearDisconnectTimer();
      // На первой попытке оставляем 'connecting' — пусть тихо переподключится.
      // На последующих — показываем мягкий 'reconnecting'.
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

export function disconnectRealtime() {
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

/** Хук: подписывается на событие и автоматически отписывается при размонтировании. */
export function useRealtimeEvent(event: string, handler: (...args: any[]) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const cb = (...args: any[]) => handlerRef.current(...args);
    s.on(event, cb);
    return () => {
      s.off(event, cb);
    };
  }, [event]);
}

/** Подписка на несколько событий. handlers — объект { event: callback } */
export function useRealtime(handlers: Record<string, (...args: any[]) => void>) {
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

/** Хук: текущее состояние соединения для UI-индикатора. */
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

/** UI-хук: показывать ли вообще baner. true только при реальной потере связи. */
export function useShouldShowOfflineBanner(): { show: boolean; state: ConnState } {
  const state = useRealtimeConnState();
  // Баннер показываем ТОЛЬКО при disconnected/reconnecting (после grace period).
  // 'idle'/'connecting'/'connected' — баннер не нужен.
  return {
    show: state === 'disconnected' || state === 'reconnecting',
    state,
  };
}
