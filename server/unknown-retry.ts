// Private producer grants do not transfer to another installation.
// Unknown remote results must be recovered before another paid submission.
export function approvedUnknownRetry(projectId: string, assetId: string, batchId: string,
  approvalId: string | undefined, unknownIds: string[]): boolean {
  return false;
}
export function approvedAudioTrial(projectId: string, segmentId: string, modelId: string,
  batchId?: string): boolean {
  return false;
}
