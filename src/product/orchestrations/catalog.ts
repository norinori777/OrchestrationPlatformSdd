import type { OrchestrationDefinition } from '../types.ts';
import { fileUploadAndMail } from './fileUploadAndMail.ts';
import { userCreateFlow } from './userCreateFlow.ts';
import { relationSyncFlow } from './relationSyncFlow.ts';

export type OrchestrationId =
  | 'file-upload-and-mail'
  | 'user-create-flow'
  | 'relation-sync-flow';

export const ORCHESTRATION_CATALOG: Record<OrchestrationId, OrchestrationDefinition> = {
  'file-upload-and-mail': fileUploadAndMail,
  'user-create-flow':     userCreateFlow,
  'relation-sync-flow':   relationSyncFlow,
};

export function isOrchestrationId(value: string): value is OrchestrationId {
  return value in ORCHESTRATION_CATALOG;
}

export function resolveOrchestrationDefinition(orchestrationId: string): OrchestrationDefinition | undefined {
  if (!isOrchestrationId(orchestrationId)) {
    return undefined;
  }
  return ORCHESTRATION_CATALOG[orchestrationId];
}
