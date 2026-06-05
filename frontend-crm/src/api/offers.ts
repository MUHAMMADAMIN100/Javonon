import { api } from './client';

export interface OfferTemplate {
  id: string;
  title: string;
  content: string;
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { signatures: number };
}

export interface OfferSignature {
  id: string;
  userId: string;
  offerId: string;
  signedAt: string;
  ip: string | null;
  userAgent: string | null;
  user?: { id: string; fullName: string; email: string };
}

export interface CurrentOfferState {
  offer: OfferTemplate;
  signed: boolean;
  signedAt: string | null;
}

export const offerCurrent = () =>
  api.get<CurrentOfferState>('/offers/current').then((r) => r.data);

export const offerSign = (id: string) =>
  api.post<OfferSignature>(`/offers/${id}/sign`).then((r) => r.data);

// Admin
export const offerList = () =>
  api.get<OfferTemplate[]>('/offers').then((r) => r.data);

export const offerCreate = (data: { title?: string; content: string }) =>
  api.post<OfferTemplate>('/offers', data).then((r) => r.data);

export const offerPatch = (id: string, data: { title?: string; content?: string }) =>
  api.patch<OfferTemplate>(`/offers/${id}`, data).then((r) => r.data);

export const offerSignatures = (id: string) =>
  api.get<OfferSignature[]>(`/offers/${id}/signatures`).then((r) => r.data);

export const offerDelete = (id: string) =>
  api.delete<{ ok: true }>(`/offers/${id}`).then((r) => r.data);
