-- CreateTable
CREATE TABLE "service_users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_users_tenantId_idx" ON "service_users"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "service_users_tenantId_email_key" ON "service_users"("tenantId", "email");
