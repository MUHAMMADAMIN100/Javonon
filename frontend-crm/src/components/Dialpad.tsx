import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import Icon from '../Icon';
import { useUI } from '../ui/Dialogs';
import { createCall } from '../api/calls';
import { api } from '../api/client';

/**
 * Плавающий dialpad — программа-телефон в CRM (по ТЗ §6d).
 *
 * Поведение:
 *  - FAB-кнопка с трубкой внизу-справа открывает панель.
 *  - Набор номера: клавиши + редактируемое поле.
 *  - Кнопка «Позвонить»:
 *     1) Сначала пробуем выпустить Twilio Voice token через /integrations/
 *        telephony/token. Если бэк вернул реальный токен (не stub) и в
 *        window есть Twilio Voice SDK — используем его (caller-id и
 *        исходящий звонок через WebRTC). Сейчас SDK не подключен, так
 *        что эта ветка по умолчанию не сработает — это нормально.
 *     2) Fallback: `window.location.href = 'tel:+...'` — открывает
 *        системный обработчик звонков. На десктопе обычно делегирует
 *        FaceTime/Skype/etc., на телефоне — звонит.
 *  - После «отбоя» (или явного завершения) предлагает залогировать
 *    звонок в CallLog через POST /calls с продолжительностью и
 *    результатом. Это покрывает ТЗ §6e «автоматическая фиксация в CRM».
 */
export default function Dialpad() {
  const { toast } = useUI();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('+992');
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'in-call' | 'finishing'>('idle');
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const deviceRef = useRef<any>(null);
  const connRef = useRef<any>(null);

  // Тик-таймер во время звонка для отображения хронометра.
  useEffect(() => {
    if (callState !== 'in-call') return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [callState]);

  const callSeconds = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;

  const append = (digit: string) => {
    if (callState !== 'idle') return;
    setNumber((n) => (n + digit).slice(0, 20));
  };
  const backspace = () => {
    if (callState !== 'idle') return;
    setNumber((n) => n.slice(0, -1));
  };
  const clear = () => {
    if (callState !== 'idle') return;
    setNumber('+');
  };

  const dial = async () => {
    const cleaned = number.trim();
    if (!cleaned || cleaned === '+') {
      toast('Введи номер', 'error');
      return;
    }
    setCallState('connecting');
    // 1) Пробуем Twilio Voice.
    let twilioOk = false;
    try {
      const { data } = await api.get<{ token: string; identity: string }>('/integrations/telephony/token');
      const twilioGlobal = (window as any).Twilio;
      if (
        data?.token &&
        data.token !== '__TWILIO_TOKEN_PLACEHOLDER__' &&
        twilioGlobal?.Device
      ) {
        const device = new twilioGlobal.Device(data.token, { logLevel: 1 });
        deviceRef.current = device;
        await new Promise((resolve, reject) => {
          device.on('registered', resolve);
          device.on('error', reject);
          device.register();
        });
        const conn = await device.connect({ params: { To: cleaned } });
        connRef.current = conn;
        conn.on('accept', () => {
          setCallStartedAt(Date.now());
          setCallState('in-call');
        });
        conn.on('disconnect', () => {
          handleEnd(cleaned, conn);
        });
        twilioOk = true;
      }
    } catch (e: any) {
      // Просто переходим к fallback.
      console.warn('Twilio Voice unavailable:', e?.message);
    }

    if (!twilioOk) {
      // Fallback: системный звонок. Браузер откроет внешний обработчик.
      // CallLog логируем сразу с длительностью 0 — менеджер потом дозаполнит.
      window.location.href = `tel:${cleaned}`;
      setCallState('finishing');
      // Через короткую паузу выводим форму логирования.
      setTimeout(() => promptLog(cleaned, 0), 500);
    }
  };

  const handleEnd = (to: string, conn?: any) => {
    const duration = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
    setCallState('finishing');
    try { conn?.disconnect?.(); } catch { /* ignore */ }
    try { deviceRef.current?.destroy?.(); } catch { /* ignore */ }
    promptLog(to, duration);
  };

  /** После завершения звонка предлагаем зафиксировать его в CallLog. */
  const promptLog = async (to: string, durationSeconds: number) => {
    try {
      await createCall({
        clientName: to, // менеджер потом отредактирует
        clientPhone: to,
        direction: 'OUTGOING',
        outcome: durationSeconds > 5 ? 'ANSWERED' : 'NO_ANSWER',
        durationSeconds,
        notes: 'Звонок через dialpad',
      });
      qc.invalidateQueries({ queryKey: ['calls'] });
      toast('Звонок зафиксирован в CRM', 'success');
    } catch (e: any) {
      toast('Не удалось зафиксировать звонок: ' + (e?.response?.data?.message || e.message), 'error');
    } finally {
      setCallState('idle');
      setCallStartedAt(null);
    }
  };

  const hangup = () => {
    if (callState === 'in-call' || callState === 'connecting') {
      if (connRef.current) {
        handleEnd(number);
      } else {
        setCallState('finishing');
        promptLog(number, callSeconds);
      }
    }
  };

  return (
    <>
      {/* FAB кнопка — открыть/закрыть */}
      <motion.button
        className="dialpad-fab"
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title="Звонок"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: callState === 'in-call' ? '#ef4444' : 'var(--primary)',
          color: 'white',
          border: 'none',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
          cursor: 'pointer',
          zIndex: 1400,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={callState === 'in-call' ? 'call_end' : 'call'} size={26} />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'fixed',
              right: 20,
              bottom: 90,
              width: 280,
              background: 'white',
              borderRadius: 16,
              boxShadow: '0 20px 50px rgba(0,0,0,0.18)',
              padding: 16,
              zIndex: 1400,
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.16em',
                color: 'var(--primary-dark)',
              }}>DIALER</span>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-soft)' }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {/* Дисплей */}
            <div style={{
              padding: '12px 14px',
              background: 'var(--bg-soft)',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              marginBottom: 10,
            }}>
              <input
                value={number}
                onChange={(e) => setNumber(e.target.value.replace(/[^\d+*#]/g, ''))}
                disabled={callState !== 'idle'}
                style={{
                  width: '100%',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 22,
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  letterSpacing: '0.04em',
                  textAlign: 'center',
                }}
              />
              {callState === 'in-call' && (
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: '#16a34a',
                  marginTop: 4,
                  textAlign: 'center',
                }}>
                  {String(Math.floor(callSeconds / 60)).padStart(2, '0')}:
                  {String(callSeconds % 60).padStart(2, '0')} · в разговоре
                </div>
              )}
              {callState === 'connecting' && (
                <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4, textAlign: 'center' }}>
                  Соединение…
                </div>
              )}
            </div>

            {/* Клавиатура */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 6,
              marginBottom: 10,
            }}>
              {['1','2','3','4','5','6','7','8','9','*','0','#'].map((k) => (
                <DialKey key={k} digit={k} onClick={() => append(k)} />
              ))}
            </div>

            {/* Управление */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={callState === 'idle' ? dial : hangup}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  background: callState === 'idle' ? '#16a34a' : '#ef4444',
                  color: 'white',
                  border: 'none',
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 15,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Icon name={callState === 'idle' ? 'call' : 'call_end'} size={20} />
                {callState === 'idle' ? 'Позвонить' : 'Отбой'}
              </button>
              <button
                onClick={backspace}
                disabled={callState !== 'idle'}
                style={{
                  width: 48,
                  padding: '12px 0',
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                title="Стереть"
              >
                <Icon name="backspace" size={18} />
              </button>
              <button
                onClick={clear}
                disabled={callState !== 'idle'}
                style={{
                  width: 48,
                  padding: '12px 0',
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                title="Очистить"
              >
                <Icon name="clear" size={18} />
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-soft)', textAlign: 'center', lineHeight: 1.4 }}>
              Twilio Voice не подключён — пока fallback на системный обработчик (tel:). Звонок будет зафиксирован в CRM.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function DialKey({ digit, onClick }: { digit: string; onClick: () => void }) {
  const sub: Record<string, string> = {
    '2': 'abc','3':'def','4':'ghi','5':'jkl','6':'mno','7':'pqrs','8':'tuv','9':'wxyz',
  };
  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      style={{
        padding: '12px 0',
        background: 'var(--bg-soft)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        lineHeight: 1,
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-display)' }}>{digit}</span>
      {sub[digit] && (
        <span style={{ fontSize: 9, color: 'var(--text-soft)', letterSpacing: 1, marginTop: 2 }}>
          {sub[digit].toUpperCase()}
        </span>
      )}
    </motion.button>
  );
}
