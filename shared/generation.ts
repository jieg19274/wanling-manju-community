import { contentHash, digest, selectedArtifact, segmentReferences, videoReferences, type Artifact, type Episode, type Project, type Segment } from './model.js';

// Versioned, queryable provenance. Credentials are deliberately excluded.
export function generationSignature(project: Project, episode: Episode, segment: Segment): string {
  return signatureForPrompt(project, episode, segment, selectedArtifact(segment, 'prompt'));
}

// Historical provenance may use a stopped prompt; new submissions only use
// selectedArtifact, which excludes stopped versions.
function signatureForPrompt(project: Project, episode: Episode, segment: Segment, prompt?: Artifact, legacyReferences = false): string {
  const references = videoReferences(project, episode, segment).map(ref => {
    // 0.4.21 added an empty temporalScope to references without a state change.
    // Earlier films contain the exact same inputs without that optional field.
    // Preserve the current submission signature and only reconstruct the old
    // encoding when checking a retained film; actual transition timing stays.
    if (!legacyReferences || ref.temporalScope) return ref;
    const { temporalScope, ...legacy } = ref;
    return legacy;
  });
  return digest({ version: 1, projectId: project.id, episodeId: episode.id, segmentId: segment.id, source: contentHash(episode, segment),
    prompt: { id: prompt?.id, content: prompt?.content }, model: project.videoModel,
    aspectRatio: project.aspectRatio || '16:9', references });
}

function matchesPromptSignature(project: Project, episode: Episode, segment: Segment, signature: unknown, prompt?: Artifact): boolean {
  return typeof signature === 'string' && (signature === signatureForPrompt(project, episode, segment, prompt) ||
    signature === signatureForPrompt(project, episode, segment, prompt, true));
}

export function generationSignatureMatches(project: Project, episode: Episode, segment: Segment, signature: unknown): boolean {
  return matchesPromptSignature(project, episode, segment, signature, selectedArtifact(segment, 'prompt'));
}

export function currentVideo(project: Project, episode: Episode, segment: Segment, artifact: Artifact): boolean {
  try { return artifact.sourceHash === contentHash(episode, segment) &&
    generationSignatureMatches(project, episode, segment, artifact.generationHash); } catch { return false; }
}

// A reviewed film can remain usable after selecting another prompt for the
// same formal input. Reconstruct its exact historical signature; pending or
// rejected candidates never receive this compatibility path.
export function usableVideo(project: Project, episode: Episode, segment: Segment, artifact: Artifact): boolean {
  if (currentVideo(project, episode, segment, artifact)) return true;
  if (artifact.labelRepair && artifact.kind === 'video' && artifact.mediaPath && artifact.sourceHash === contentHash(episode,segment)) {
    const visited=new Set([artifact.id]); let derived=artifact;
    while(derived.labelRepair) {
      const source=segment.artifacts.find(a=>a.id===derived.labelRepair!.sourceArtifactId);
      if(!source || source.demo || source.kind!=='video' || !source.mediaPath || visited.has(source.id) || source.generationHash!==artifact.generationHash || source.sourceHash!==artifact.sourceHash ||
        !/^[a-f0-9]{64}$/u.test(derived.labelRepair.sourceFileHash) || !/^[a-f0-9]{64}$/u.test(derived.labelRepair.outputFileHash)) return false;
      visited.add(source.id); derived=source;
    }
    // A text-only derivative may be reviewed using its approved ancestor's
    // exact retained prompt. It does not inherit the ancestor's review.
    if(derived.review?.status==='approved' || derived.userAcceptance?.status==='accepted') return usableVideo(project,episode,segment,derived);
  }
  if (artifact.demo || artifact.kind !== 'video' || !artifact.mediaPath ||
    !(artifact.review?.status === 'approved' || artifact.userAcceptance?.status === 'accepted' &&
      artifact.userAcceptance.generationHash === artifact.generationHash) ||
    artifact.sourceHash !== contentHash(episode, segment)) return false;
  return segment.artifacts.some(prompt => {
    if (prompt.kind !== 'prompt' || prompt.sourceHash !== artifact.sourceHash) return false;
    try { return matchesPromptSignature(project, episode, segment, artifact.generationHash, prompt); } catch { return false; }
  });
}

export function assetInputHash(project: Project, assetId: string, stateId?: string): string {
  const asset = project.assets?.find(item => item.id === assetId);
  return digest({ asset: asset && { kind: asset.kind, name: asset.name, identity: asset.identity, voice: asset.voice,
    state: asset.states.find(item => item.id === stateId) }, style: project.visualStyle, ratio: project.aspectRatio });
}

export function invalidateAsset(project: Project, assetId?: string, imageId?: string): void {
  for (const episode of [...project.episodes, ...(project.archivedEpisodes || [])]) {
    let changed = false;
    for (const segment of episode.segments) if (!assetId || segment.assetBindings?.some(binding => binding.assetId === assetId &&
      (!imageId || binding.imageId === imageId || binding.portraitImageId === imageId))) {
      segment.assetRevision = (segment.assetRevision || 0) + 1;
      changed = true;
    }
    if (changed) { episode.auditApprovedHash = undefined; episode.sampleApprovedHash = undefined; }
  }
}

export function assetDependencies(project: Project): Map<string, string> {
  return new Map([...project.episodes, ...(project.archivedEpisodes || [])].flatMap(episode => episode.segments.map(segment => {
    try { return [segment.id, digest(segmentReferences(project, episode, segment))] as const; }
    catch { return [segment.id, 'invalid'] as const; }
  })));
}
export function invalidateChangedAssets(project: Project, before: Map<string, string>): void {
  const after = assetDependencies(project);
  for (const episode of [...project.episodes, ...(project.archivedEpisodes || [])]) for (const segment of episode.segments) {
    if (before.get(segment.id) === after.get(segment.id)) continue;
    segment.assetRevision = (segment.assetRevision || 0) + 1;
    episode.auditApprovedHash = undefined; episode.sampleApprovedHash = undefined;
  }
}
