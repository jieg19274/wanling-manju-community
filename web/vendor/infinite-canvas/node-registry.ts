const colors: Record<string, string> = {
  source: '#a78bfa', asset: '#88bca5', shot: '#e1c389',
  video: '#87a9df', anchor: '#b8a6ce', note: '#a8a29e',
};
export function getNodeDefinition(type: string) {
  return { minimapColor: colors[type] || '#a8a29e' };
}
