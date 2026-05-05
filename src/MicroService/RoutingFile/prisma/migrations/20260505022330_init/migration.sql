-- CreateTable
CREATE TABLE "routing_requests" (
    "id" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "category" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "errorMessage" TEXT,
    "chunkResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "routing_requests_status_idx" ON "routing_requests"("status");

-- CreateIndex
CREATE INDEX "routing_requests_category_idx" ON "routing_requests"("category");
