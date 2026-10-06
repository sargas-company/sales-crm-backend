-- CreateTable
CREATE TABLE "JobPostView" (
    "userId" TEXT NOT NULL,
    "jobPostId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPostView_pkey" PRIMARY KEY ("userId","jobPostId")
);

-- CreateIndex
CREATE INDEX "JobPostView_userId_viewedAt_idx" ON "JobPostView"("userId", "viewedAt");

-- AddForeignKey
ALTER TABLE "JobPostView" ADD CONSTRAINT "JobPostView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPostView" ADD CONSTRAINT "JobPostView_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
