-- CreateTable
CREATE TABLE "saas_requests" (
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

    CONSTRAINT "saas_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saas_requests_tenantId_resource_idx" ON "saas_requests"("tenantId", "resource");
