-- CreateTable
CREATE TABLE "platform_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_requests_tenantId_resource_idx" ON "platform_requests"("tenantId", "resource");
