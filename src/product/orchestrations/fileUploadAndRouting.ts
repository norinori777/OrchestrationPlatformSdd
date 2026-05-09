import type { OrchestrationDefinition } from '../types.ts';

export const fileUploadAndRouting: OrchestrationDefinition = {
  steps: [
    {
      service: 'file-storage-service',
      method: 'POST',
      path: '/api/files',
      body: {
        id: '{requestId}',
        tenantId: '{tenantId}',
        userId: '{userId}',
        filename: '{payload.filename}',
        storagePath: 'uploads/{requestId}/{payload.filename}',
        size: '{payload.size}',
        contentType: '{payload.contentType}',
        fileContentBase64: '{payload.fileContentBase64}',
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
      },
    },
  ],
};
