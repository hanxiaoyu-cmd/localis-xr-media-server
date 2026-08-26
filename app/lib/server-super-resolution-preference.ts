import type { ServerSuperResolutionLevel } from '@/server/super-resolution';

interface PreferenceStorage {
  getItem(key: string): string | null;
}

const serverLevels = new Set<ServerSuperResolutionLevel>(['off', 'standard', 'high', 'ultra', 'ai']);

const legacyLevels: Record<string, ServerSuperResolutionLevel> = {
  off: 'off',
  auto: 'standard',
  quality: 'high',
  sharp: 'standard',
};

export function savedServerSuperResolution(storage?: PreferenceStorage): ServerSuperResolutionLevel {
  if (!storage) return 'off';

  const saved = storage.getItem('localis.serverSuperResolution');
  if (saved !== null) {
    return serverLevels.has(saved as ServerSuperResolutionLevel)
      ? saved as ServerSuperResolutionLevel
      : 'off';
  }

  const legacy = storage.getItem('localis.superResolution');
  return legacy ? legacyLevels[legacy] ?? 'off' : 'off';
}
