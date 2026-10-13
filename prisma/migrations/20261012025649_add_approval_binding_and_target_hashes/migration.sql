-- AlterTable
ALTER TABLE "PatchProposal" ADD COLUMN     "approvedDiffHash" TEXT,
ADD COLUMN     "targetFileHashes" JSONB;

-- CreateIndex
CREATE INDEX "PatchProposal_id_status_idx" ON "PatchProposal"("id", "status");
