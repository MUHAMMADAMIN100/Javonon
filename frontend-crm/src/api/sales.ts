import { api } from './client';

export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  order: number;
  color: string | null;
  isClosingStage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  stages: PipelineStage[];
  createdAt: string;
  updatedAt: string;
}

// --- Pipelines CRUD ---
export const listPipelines = () =>
  api.get<Pipeline[]>('/sales/pipelines').then((r) => r.data);

export const createPipeline = (data: {
  name: string;
  description?: string;
  isDefault?: boolean;
  stages?: Array<{ name: string; color?: string; isClosingStage?: boolean }>;
}) => api.post<Pipeline>('/sales/pipelines', data).then((r) => r.data);

export const updatePipeline = (id: string, patch: Partial<Pick<Pipeline, 'name' | 'description' | 'isDefault' | 'isActive'>>) =>
  api.patch<Pipeline>(`/sales/pipelines/${id}`, patch).then((r) => r.data);

export const deletePipeline = (id: string) =>
  api.delete(`/sales/pipelines/${id}`).then((r) => r.data);

// --- Stages ---
export const addStage = (pipelineId: string, data: { name: string; color?: string; isClosingStage?: boolean }) =>
  api.post<PipelineStage>(`/sales/pipelines/${pipelineId}/stages`, data).then((r) => r.data);

export const updateStage = (id: string, patch: Partial<Pick<PipelineStage, 'name' | 'order' | 'color' | 'isClosingStage'>>) =>
  api.patch<PipelineStage>(`/sales/stages/${id}`, patch).then((r) => r.data);

export const deleteStage = (id: string) =>
  api.delete(`/sales/stages/${id}`).then((r) => r.data);

// --- Lead manual reassignment ---
export const reassignLead = (applicationId: string, managerId: string | null) =>
  api.post(`/sales/applications/${applicationId}/assign`, { managerId }).then((r) => r.data);

// --- Pipeline stage transition ---
export const moveApplicationStage = (applicationId: string, pipelineStageId: string | null) =>
  api.post(`/sales/applications/${applicationId}/move-stage`, { pipelineStageId }).then((r) => r.data);
