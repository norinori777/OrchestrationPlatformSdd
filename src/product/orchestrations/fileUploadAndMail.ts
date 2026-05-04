import type { OrchestrationDefinition } from '../types.ts';

export const fileUploadAndMail: OrchestrationDefinition = {
  steps: [
    {
      service: 'file-storage-service',
      method: 'POST',
      path: '/api/files',
      body: {
        filename: '{requestId}.pdf',
        contentType: 'application/pdf',
        storagePath: '/uploads/{requestId}.pdf',
      },
      compensation: {
        service: 'file-storage-service',
        method: 'DELETE',
        path: '/api/files/{step0.body.id}',
      },
    },
    {
      service: 'mail-service',
      method: 'POST',
      path: '/api/mail/send',
      body: {
        to: '{userId}@example.com',
        subject: 'ダウンロードURLのお知らせ',
        body: 'ファイルはこちら: {step0.body.downloadUrl}',
      },
    },
  ],
};
