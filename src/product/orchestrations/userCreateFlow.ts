import type { OrchestrationDefinition } from '../types.ts';

export const userCreateFlow: OrchestrationDefinition = {
  steps: [
    {
      service: 'user-service',
      method: 'POST',
      path: '/api/users',
      body: {
        email: '{userId}@example.com',
        name: 'New User',
        role: 'viewer',
      },
      compensation: {
        service: 'user-service',
        method: 'DELETE',
        path: '/api/users/{step0.body.id}',
      },
    },
    {
      service: 'file-storage-service',
      method: 'POST',
      path: '/api/files',
      body: {
        filename: '{step0.body.id}.txt',
        contentType: 'text/plain',
        storagePath: '/users/{step0.body.id}/profile.txt',
      },
    },
  ],
};
