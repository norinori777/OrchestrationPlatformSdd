import type { OrchestrationDefinition } from '../types.ts';

export const fileUploadAndRouting: OrchestrationDefinition = {
  steps: [
    {
      service: 'file-storage-service',
      method: 'POST',
      path: '/api/files',
      body: {
        filename: '{requestId}.txt',
        storagePath: '/uploads/{requestId}.txt',
        size: 0,
        contentType: 'text/plain',
      },
      compensation: {
        service: 'file-storage-service',
        method: 'DELETE',
        path: '/api/files/{step0.body.id}',
      },
    },
    {
      service: 'routing-file-service',
      method: 'POST',
      path: '/api/routing/classify',
      body: {
        filePath: '{step0.body.storagePath}',
        originalName: '{step0.body.filename}',
        mimeType: '{step0.body.contentType}',
        size: '{step0.body.size}',
      },
    },
  ],
};
