import type { BuildMetadata, BuildMetadataReadResult } from '@/server/build-metadata';

export type BuildCompatibility = 'match' | 'mismatch' | 'unverifiable';

function parseClientBuildMetadata(value?: string): BuildMetadata | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<BuildMetadata>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.buildId !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.buildId)
      || typeof parsed.version !== 'string'
      || typeof parsed.commitSha !== 'string'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.commitSha)
      || typeof parsed.commitShortSha !== 'string'
      || parsed.commitShortSha !== parsed.commitSha.slice(0, 12)
      || typeof parsed.buildTime !== 'string'
      || typeof parsed.dirty !== 'boolean'
      || typeof parsed.channel !== 'string'
    ) return undefined;
    return parsed as BuildMetadata;
  } catch {
    return undefined;
  }
}

export const clientBuildMetadata = parseClientBuildMetadata(process.env.NEXT_PUBLIC_LOCALIS_BUILD_METADATA);

export function compareBuildMetadata(
  client: BuildMetadata | undefined,
  server: BuildMetadataReadResult | undefined,
): BuildCompatibility {
  if (!client) return 'unverifiable';
  if (!server?.available) return 'mismatch';
  return client.buildId === server.metadata.buildId ? 'match' : 'mismatch';
}

export function buildReloadKey(client: BuildMetadata, server?: BuildMetadataReadResult): string {
  const serverBuildId = server?.available ? server.metadata.buildId : server?.reason || 'missing';
  return `localis-build-reload:${client.buildId}:${serverBuildId}`;
}
