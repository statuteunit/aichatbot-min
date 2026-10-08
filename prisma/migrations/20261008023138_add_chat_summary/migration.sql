-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryUpToMsgId" TEXT,
ADD COLUMN     "summaryUpdatedAt" TIMESTAMP(3);
