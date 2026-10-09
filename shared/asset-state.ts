import type { Episode, Segment, StoryAsset, AssetState } from './model.js';

export function effectiveState(asset: StoryAsset, episode: Episode, segment: Pick<Segment, 'number'>,
  overrideId?: string): AssetState | undefined {
  if (overrideId) return asset.states.find(state => state.id === overrideId);
  return [...asset.states].filter(state => state.startEpisode < episode.number ||
    (state.startEpisode === episode.number && state.startSegment <= segment.number))
    .sort((a, b) => b.startEpisode - a.startEpisode || b.startSegment - a.startSegment)[0];
}
