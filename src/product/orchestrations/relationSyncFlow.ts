import type { OrchestrationDefinition } from '../types.ts';

export const relationSyncFlow: OrchestrationDefinition = {
  steps: [
    {
      service: 'routing-file-service',
      method: 'POST',
      path: '/api/routing/classify',
      body: {
        filePath: '/data/input.json',
        originalName: 'input.json',
        mimeType: 'application/json',
      },
      compensation: {
        service: 'routing-file-service',
        method: 'DELETE',
        path: '/api/routing/{step0.body.id}',
      },
    },
    {
      service: 'user-service',
      method: 'POST',
      path: '/api/users',
      body: {
        email: '{userId}@example.com',
        name: 'Synced User',
      },
    },
    {
      service: 'file-storage-service',
      method: 'POST',
      path: '/api/files',
      body: {
        filename: 'relation-sync.txt',
        contentType: 'text/plain',
        storagePath: '/relations/{step1.body.id}/sync.txt',
      },
    },
  ],
};
