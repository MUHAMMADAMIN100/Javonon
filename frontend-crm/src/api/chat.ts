import { api } from './client';

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
  forwardedFrom?: ChatMessageReplyTo | null;
  isPinned?: boolean;
  deletedAt?: string | null;
  reactions?: ChatReaction[];
}

export interface ChatMember {
  id: string;
  userId: string;
  user: { id: string; fullName: string; role: string };
  lastReadAt: string | null;
}

export interface ChatRoom {
  id: string;
  type: ChatRoomType;
  title: string | null;
  members: ChatMember[];
  messages: ChatMessage[];
  updatedAt: string;
}

export const listChatRooms = () => api.get<ChatRoom[]>('/chat/rooms').then((r) => r.data);
export const getChatRoom = (id: string) =>
  api.get<{ messages: ChatMessage[] }>(`/chat/rooms/${id}`).then((r) => r.data);

/** Telegram-style: можно прикрепить files (multipart) и replyToId. */
export const sendChatMessage = (
  roomId: string,
  text: string,
  options: { mentionsIds?: string[]; replyToId?: string; files?: File[] } = {},
) => {
  const fd = new FormData();
  if (text) fd.append('text', text);
  if (options.mentionsIds?.length) fd.append('mentionsIds', JSON.stringify(options.mentionsIds));
  if (options.replyToId) fd.append('replyToId', options.replyToId);
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
export const chatUnread = () => api.get<Array<{ roomId: string; unread: number }>>('/chat/unread').then((r) => r.data);

// Telegram-style actions
export const reactToMessage = (messageId: string, emoji: string) =>
  api.post<{ ok: boolean; action: 'added' | 'removed' }>(`/chat/messages/${messageId}/react`, { emoji }).then((r) => r.data);
export const deleteChatMessage = (messageId: string) =>
  api.delete<{ ok: boolean }>(`/chat/messages/${messageId}`).then((r) => r.data);
export const pinChatMessage = (messageId: string) =>
  api.patch<{ ok: boolean; isPinned: boolean }>(`/chat/messages/${messageId}/pin`).then((r) => r.data);
export const forwardChatMessage = (messageId: string, targetRoomId: string) =>
  api.post<ChatMessage>(`/chat/messages/${messageId}/forward`, { targetRoomId }).then((r) => r.data);
export const listPinnedMessages = (roomId: string) =>
  api.get<ChatMessage[]>(`/chat/rooms/${roomId}/pinned`).then((r) => r.data);

/** Уведомить других участников что я печатаю (или прекратил). Эфемерно — не сохраняется. */
export const setTyping = (roomId: string, typing: boolean) =>
  api.post(`/chat/rooms/${roomId}/typing`, { typing }).then((r) => r.data);

/** Telegram-style: пометить комнату прочитанной (для read-receipts ✓✓). */
export const markRoomRead = (roomId: string) =>
  api.post<{ ok: boolean; lastReadAt: string }>(`/chat/rooms/${roomId}/read`).then((r) => r.data);
