// Studio owns the theme; this adapter replaces the upstream application's global store.
export function useThemeStore<T>(selector: (state: { theme: 'dark' }) => T): T {
  return selector({ theme: 'dark' });
}
