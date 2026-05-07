import { api } from './client';

export type ChatRoomType = 'GENERAL' | 'TEAM' | 'DIRECT';

export interface ChatMessage {
  id: string;
  roomId: string;
  authorId: string;
  text: string;
  mentionsIds: string[];
  createdAt: string;
  editedAt: string | null;
  author?: { id: string; fullName: string; role: string };
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
export const sendChatMessage = (roomId: string, text: string, mentionsIds?: string[]) =>
  api.post<ChatMessage>(`/chat/rooms/${roomId}/messages`, { text, mentionsIds }).then((r) => r.data);
export const createTeamRoom = (title: string, memberIds: string[]) =>
  api.post<ChatRoom>('/chat/rooms/team', { title, memberIds }).then((r) => r.data);
export const createDirectRoom = (userId: string) =>
  api.post<ChatRoom>('/chat/rooms/direct', { userId }).then((r) => r.data);
export const chatUnread = () => api.get<Array<{ roomId: string; unread: number }>>('/chat/unread').then((r) => r.data);
