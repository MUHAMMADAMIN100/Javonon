import { api } from './client';
import { getSocket } from '../realtime';

export type ChatRoomType = 'GENERAL' | 'TEAM' | 'DIRECT';

export interface ChatAttachment {
  url: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface ChatReaction {
  id: string;
  emoji: string;
  userId: string;
}

export interface ChatMessageReplyTo {
  id: string;
  text: string;
  authorId: string;
  attachments?: ChatAttachment[] | null;
  deletedAt?: string | null;
  author?: { id: string; fullName: string };
}

export interface ChatMessage {
  id: string;
  roomId: string;
  authorId: string;
  text: string;
  mentionsIds: string[];
  createdAt: string;
  editedAt: string | null;
  author?: { id: string; fullName: string; role: string };
  attachments?: ChatAttachment[] | null;
  replyToId?: string | null;
  replyTo?: ChatMessageReplyTo | null;
  forwardedFromId?: string | null;
  forwardedFrom?: { id: string; authorId: string; author?: { id: string; fullName: string } } | null;
  isPinned?: boolean;
  deletedAt?: string | null;
  reactions?: ChatReaction[];
}

export interface ChatMember {
  id: string;
  userId: string;
  user: { id: string; fullName: string; role: string };
  lastReadAt: string | null;
  clearedAt?: string | null;
}

export interface ChatRoom {
  id: string;
  type: ChatRoomType;
  title: string | null;
  /** Создатель команды — её админ (вместе с основателем). */
  createdById?: string | null;
  members: ChatMember[];
  messages: ChatMessage[];
  updatedAt: string;
}

export const listChatRooms = () => api.get<ChatRoom[]>('/chat/rooms').then((r) => r.data);
/** Переписка порциями: без before — последние, с before — более старые. */
export const getChatRoom = (id: string, before?: string) =>
  api.get<{ messages: ChatMessage[]; hasMore: boolean }>(`/chat/rooms/${id}`, { params: before ? { before } : undefined }).then((r) => r.data);

export interface ChatRoomMember {
  id: string;
  fullName: string;
  role: string;
  roles?: string[];
  online: boolean;
  lastSeenAt: string | null;
  isAdmin: boolean;
}
export const getChatRoomMembers = (roomId: string) =>
  api.get<ChatRoomMember[]>(`/chat/rooms/${roomId}/members`).then((r) => r.data);
export interface ChatSearchHit {
  id: string;
  text: string;
  createdAt: string;
  authorId: string;
  author?: { id: string; fullName: string };
}
export const searchChatMessages = (roomId: string, q: string) =>
  api.get<ChatSearchHit[]>(`/chat/rooms/${roomId}/search`, { params: { q } }).then((r) => r.data);
/** Удалить чат: личный — у себя или у обоих (forAll), команду — только админ. */
export const deleteChatRoom = (roomId: string, forAll = false) =>
  api.delete<{ ok: boolean }>(`/chat/rooms/${roomId}`, { params: forAll ? { for: 'all' } : undefined }).then((r) => r.data);
export const leaveChatRoom = (roomId: string) =>
  api.post<{ ok: boolean }>(`/chat/rooms/${roomId}/leave`).then((r) => r.data);

/** Telegram-style: можно прикрепить files (multipart) и replyToId. */
export const sendChatMessage = (
  roomId: string,
  text: string,
  options: { mentionsIds?: string[]; replyToId?: string; files?: File[]; clientId?: string } = {},
) => {
  const fd = new FormData();
  if (text) fd.append('text', text);
  if (options.mentionsIds?.length) fd.append('mentionsIds', JSON.stringify(options.mentionsIds));
  if (options.replyToId) fd.append('replyToId', options.replyToId);
  if (options.clientId) fd.append('clientId', options.clientId);
  for (const f of options.files || []) fd.append('files', f);
  return api
    .post<ChatMessage>(`/chat/rooms/${roomId}/messages`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
};

export const createTeamRoom = (title: string, memberIds: string[]) =>
  api.post<ChatRoom>('/chat/rooms/team', { title, memberIds }).then((r) => r.data);
export const createDirectRoom = (userId: string) =>
  api.post<ChatRoom>('/chat/rooms/direct', { userId }).then((r) => r.data);
/** unread — непрочитанных сообщений, mentions — из них с упоминанием меня (значок «@»). */
export const chatUnread = () => api.get<Array<{ roomId: string; unread: number; mentions?: number }>>('/chat/unread').then((r) => r.data);

// Telegram-style actions
export const reactToMessage = (messageId: string, emoji: string) =>
  api.post<{ ok: boolean; action: 'added' | 'removed' }>(`/chat/messages/${messageId}/react`, { emoji }).then((r) => r.data);
export const deleteChatMessage = (messageId: string) =>
  api.delete<{ ok: boolean }>(`/chat/messages/${messageId}`).then((r) => r.data);
export const deleteChatMessages = (ids: string[]) =>
  api.post<{ ok: boolean; deleted: number }>('/chat/messages/delete', { ids }).then((r) => r.data);
export const editChatMessage = (messageId: string, text: string) =>
  api.patch<{ ok: boolean; id: string; text: string; editedAt: string }>(`/chat/messages/${messageId}`, { text }).then((r) => r.data);
export const pinChatMessage = (messageId: string) =>
  api.patch<{ ok: boolean; isPinned: boolean }>(`/chat/messages/${messageId}/pin`).then((r) => r.data);
export const forwardChatMessage = (messageId: string, targetRoomId: string) =>
  api.post<ChatMessage>(`/chat/messages/${messageId}/forward`, { targetRoomId }).then((r) => r.data);
export const listPinnedMessages = (roomId: string) =>
  api.get<ChatMessage[]>(`/chat/rooms/${roomId}/pinned`).then((r) => r.data);

/** Уведомить других участников что я печатаю (или прекратил). Эфемерно — не сохраняется. */
export const setTyping = (roomId: string, typing: boolean) =>
  api.post(`/chat/rooms/${roomId}/typing`, { typing }).then((r) => r.data);

/** «Печатает…» — через сокет; нет соединения — обычным запросом. */
export function sendTyping(roomId: string, typing: boolean) {
  const s = getSocket();
  if (s?.connected) {
    s.emit('chat:typing', { roomId, typing });
    return;
  }
  setTyping(roomId, typing).catch(() => undefined);
}

/**
 * Текстовое сообщение — через сокет с подтверждением: собеседник получает
 * его в тот же момент, автор — готовое сообщение в ответ. Если сокета нет
 * или он не ответил за 8 с — отправляем обычным запросом, сообщение не
 * теряется. clientId — метка черновика, по ней он заменяется настоящим.
 */
export function sendChatMessageLive(
  roomId: string,
  text: string,
  options: { replyToId?: string; clientId: string },
): Promise<ChatMessage> {
  const viaHttp = () => sendChatMessage(roomId, text, { replyToId: options.replyToId, clientId: options.clientId });
  const s = getSocket();
  if (!s?.connected) return viaHttp();
  return new Promise<ChatMessage>((resolve, reject) => {
    s.timeout(8000).emit(
      'chat:send',
      { roomId, text, replyToId: options.replyToId, clientId: options.clientId },
      (err: unknown, res: { ok: boolean; message?: ChatMessage; error?: string }) => {
        if (err) {
          viaHttp().then(resolve, reject);
          return;
        }
        if (res?.ok && res.message) resolve(res.message);
        else reject(Object.assign(new Error(res?.error || 'send failed'), { response: { data: { message: res?.error } } }));
      },
    );
  });
}

/** Telegram-style: пометить комнату прочитанной (для read-receipts ✓✓). */
const markRoomReadHttp = (roomId: string) =>
  api.post<{ ok: boolean; lastReadAt: string }>(`/chat/rooms/${roomId}/read`).then((r) => r.data);

/**
 * «Прочитал» — через сокет (в живом чате это частое событие, по HTTP оно
 * съедало лимит запросов); нет соединения — обычным запросом.
 */
export function markRoomRead(roomId: string): Promise<unknown> {
  const s = getSocket();
  if (!s?.connected) return markRoomReadHttp(roomId);
  return new Promise((resolve) => {
    s.timeout(8000).emit('chat:read', { roomId }, (err: unknown, res: unknown) => {
      if (err) markRoomReadHttp(roomId).then(resolve, () => resolve(null));
      else resolve(res);
    });
  });
}

/** Кто прочитал моё сообщение и когда (readAt=null — прочитал до того, как время стали запоминать). */
export interface ChatMessageRead {
  userId: string;
  fullName: string;
  readAt: string | null;
}
export const getMessageReads = (messageId: string) =>
  api.get<ChatMessageRead[]>(`/chat/messages/${messageId}/reads`).then((r) => r.data);
