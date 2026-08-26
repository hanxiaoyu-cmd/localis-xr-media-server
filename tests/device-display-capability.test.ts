import { describe, expect, it } from 'vitest';
import {
  DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS,
  DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION,
  DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY,
  DEVICE_DISPLAY_PIPELINE_VERSION,
  createGuidedUserDeviceDisplayProfile,
  deviceDisplayCapabilityGrantMatchesRequest,
  getOrCreateDeviceDisplayInstallationId,
  isDeviceDisplayCapabilityGrant,
  readDeviceDisplayCapabilityStore,
  resetDeviceDisplayCapabilityStore,
  resolveDeviceDisplayCapabilityGrant,
  revokeDeviceDisplayCapabilityProfile,
  upsertDeviceDisplayCapabilityProfile,
  writeDeviceDisplayCapabilityStore,
  type DeviceDisplayCapabilityRequest,
  type DeviceDisplayStorage,
  type ExactDisplayMediaInput,
  type PersistedDeviceDisplayCapabilityProfileV1,
} from '../app/lib/device-display-capability';

const installationId = '11111111-1111-4111-8111-111111111111';
const otherInstallationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const profileId = '22222222-2222-4222-8222-222222222222';
const now = '2026-01-01T00:00:00.000Z';
const day = 24 * 60 * 60 * 1_000;

class MemoryStorage implements DeviceDisplayStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const environment = {
  origin: 'https://xr.example.test:8443/player',
  browserProduct: 'chrome' as const,
  browserEngine: 'webkit' as const,
  browserMajor: 26,
  platform: 'visionOS',
  presentation: 'webxr' as const,
  pipelineVersion: DEVICE_DISPLAY_PIPELINE_VERSION,
};

const media: ExactDisplayMediaInput = {
  mediaId: 'movie-1',
  size: 12_345_678_901,
  modifiedAt: '2025-12-31T23:00:00.000Z',
  codec: 'HEVC',
  profile: 'Main 10',
  level: 153,
  pixelFormat: 'YUV420P10LE',
  bitDepth: 10,
  dynamicRange: 'hdr10',
  colorPrimaries: 'BT2020',
  colorTransfer: 'SMPTE2084',
  colorSpace: 'BT2020NC',
  colorRange: 'TV',
  container: 'Matroska,WebM',
  width: 7680,
  height: 3840,
  fps: 59.94,
  projection: 'equirect180',
  stereo: 'sbs',
};

function initialize(storage: MemoryStorage) {
  const result = getOrCreateDeviceDisplayInstallationId(storage, () => installationId);
  expect(result).toEqual({ ok: true, value: installationId });
}

function createProfile(
  overrides: Partial<Parameters<typeof createGuidedUserDeviceDisplayProfile>[0]> = {},
) {
  const result = createGuidedUserDeviceDisplayProfile({
    installationId,
    environment,
    media,
    now,
    validForDays: 30,
    randomUUID: () => profileId,
    ...overrides,
  });
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.profile;
}

function storeProfile(storage: MemoryStorage, profile = createProfile()) {
  initialize(storage);
  const result = upsertDeviceDisplayCapabilityProfile(storage, profile);
  expect(result.ok).toBe(true);
  return profile;
}

function request(
  overrides: Partial<DeviceDisplayCapabilityRequest> = {},
): DeviceDisplayCapabilityRequest {
  return {
    installationId,
    environment,
    media,
    now: new Date(now).getTime() + day,
    ...overrides,
  };
}

describe('device display capability v1 storage', () => {
  it('creates one installation UUID, preserves it, and writes a v1 store', () => {
    const storage = new MemoryStorage();
    const first = getOrCreateDeviceDisplayInstallationId(storage, () => installationId);
    const second = getOrCreateDeviceDisplayInstallationId(storage, () => otherInstallationId);

    expect(first).toEqual({ ok: true, value: installationId });
    expect(second).toEqual({ ok: true, value: installationId });
    expect(readDeviceDisplayCapabilityStore(storage)).toEqual({
      ok: true,
      store: {
        schemaVersion: DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION,
        installationId,
        profiles: [],
      },
    });
  });

  it('reads, writes, upserts, replaces, revokes and resets profiles', () => {
    const storage = new MemoryStorage();
    const original = storeProfile(storage);
    const replacement: PersistedDeviceDisplayCapabilityProfileV1 = {
      ...original,
      expiresAt: '2026-01-20T00:00:00.000Z',
    };

    expect(upsertDeviceDisplayCapabilityProfile(storage, replacement).ok).toBe(true);
    let read = readDeviceDisplayCapabilityStore(storage);
    expect(read.ok && read.store.profiles).toHaveLength(1);
    expect(read.ok && read.store.profiles[0].expiresAt).toBe('2026-01-20T00:00:00.000Z');

    expect(revokeDeviceDisplayCapabilityProfile(
      storage,
      profileId,
      new Date(now).getTime() + 2 * day,
    ).ok).toBe(true);
    read = readDeviceDisplayCapabilityStore(storage);
    expect(read.ok && read.store.profiles[0].revokedAt).toBe('2026-01-03T00:00:00.000Z');

    expect(resetDeviceDisplayCapabilityStore(storage)).toEqual({ ok: true, value: undefined });
    expect(readDeviceDisplayCapabilityStore(storage)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('supersedes a repeated confirmation for the same binding and exact scope', () => {
    const storage = new MemoryStorage();
    initialize(storage);
    const first = createProfile();
    const otherMedia = createProfile({
      media: { ...media, mediaId: 'movie-2' },
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
    });
    const reconfirmed = createProfile({
      now: '2026-01-02T00:00:00.000Z',
      randomUUID: () => '44444444-4444-4444-8444-444444444444',
    });

    expect(upsertDeviceDisplayCapabilityProfile(storage, first).ok).toBe(true);
    expect(upsertDeviceDisplayCapabilityProfile(storage, otherMedia).ok).toBe(true);
    expect(upsertDeviceDisplayCapabilityProfile(storage, reconfirmed).ok).toBe(true);

    const read = readDeviceDisplayCapabilityStore(storage);
    expect(read.ok && read.store.profiles.map((profile) => profile.id)).toEqual([
      otherMedia.id,
      reconfirmed.id,
    ]);
  });

  it('does not silently replace corrupt or unknown-schema data while initializing', () => {
    for (const [serialized, reason] of [
      ['{broken', 'corrupt'],
      [JSON.stringify({ schemaVersion: 2, installationId, profiles: [] }), 'unknown-schema'],
      [JSON.stringify({ schemaVersion: 1, installationId: 'not-a-uuid', profiles: [] }), 'corrupt'],
    ] as const) {
      const storage = new MemoryStorage();
      storage.setItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY, serialized);

      expect(readDeviceDisplayCapabilityStore(storage)).toMatchObject({ ok: false, reason });
      expect(getOrCreateDeviceDisplayInstallationId(storage, () => otherInstallationId))
        .toMatchObject({ ok: false, reason });
      expect(storage.getItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY)).toBe(serialized);
    }
  });

  it('fails closed on an invalid profile, duplicated UUID or lifetime over 90 days', () => {
    const profile = createProfile();
    const corruptStores = [
      { schemaVersion: 1, installationId, profiles: [{ ...profile, id: 'bad-id' }] },
      { schemaVersion: 1, installationId, profiles: [profile, profile] },
      {
        schemaVersion: 1,
        installationId,
        profiles: [{
          ...profile,
          expiresAt: new Date(new Date(profile.createdAt).getTime()
            + DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS + 1).toISOString(),
        }],
      },
    ];

    for (const store of corruptStores) {
      const storage = new MemoryStorage();
      storage.setItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY, JSON.stringify(store));
      expect(readDeviceDisplayCapabilityStore(storage)).toMatchObject({ ok: false, reason: 'corrupt' });
      expect(resolveDeviceDisplayCapabilityGrant(storage, request()))
        .toMatchObject({ granted: false, reason: 'storage-corrupt' });
    }
  });

  it('reports localStorage failures without granting or clearing data', () => {
    const storage: DeviceDisplayStorage = {
      getItem() { throw new Error('read denied'); },
      setItem() { throw new Error('write denied'); },
      removeItem() { throw new Error('reset denied'); },
    };

    expect(readDeviceDisplayCapabilityStore(storage))
      .toMatchObject({ ok: false, reason: 'storage-error', detail: 'read denied' });
    expect(resolveDeviceDisplayCapabilityGrant(storage, request()))
      .toMatchObject({ granted: false, reason: 'storage-error' });
    expect(resetDeviceDisplayCapabilityStore(storage))
      .toMatchObject({ ok: false, reason: 'storage-error', detail: 'reset denied' });
  });

  it('validates store objects before serializing them', () => {
    const storage = new MemoryStorage();
    const invalid = {
      schemaVersion: 1,
      installationId,
      profiles: [{ ...createProfile(), revokedAt: 'not-a-date' }],
    } as never;

    expect(writeDeviceDisplayCapabilityStore(storage, invalid))
      .toMatchObject({ ok: false, reason: 'invalid-profile' });
    expect(storage.getItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY)).toBeNull();
  });
});

describe('guided exact-media profile creation', () => {
  it('locally creates only guided-user evidence and canonical exact-media scope', () => {
    const profile = createProfile();

    expect(profile.evidence).toEqual({ source: 'guided-user', recordedAt: now });
    expect(profile.scope).toEqual({
      kind: 'exact-media',
      media: {
        ...media,
        modifiedAt: '2025-12-31T23:00:00.000Z',
        codec: 'hevc',
        profile: 'main 10',
        pixelFormat: 'yuv420p10le',
        colorPrimaries: 'bt2020',
        colorTransfer: 'smpte2084',
        colorSpace: 'bt2020nc',
        colorRange: 'tv',
        container: 'matroska,webm',
      },
    });
    expect(profile.binding).toEqual({
      installationId,
      ...environment,
      origin: 'https://xr.example.test:8443',
      platform: 'visionos',
    });
  });

  it.each(['hdr10', 'hlg', 'sdr10'] as const)('allows an exact %s guided verification', (dynamicRange) => {
    expect(createGuidedUserDeviceDisplayProfile({
      installationId,
      environment,
      media: { ...media, dynamicRange },
      now,
      randomUUID: () => profileId,
    })).toMatchObject({
      ok: true,
      profile: { scope: { media: { dynamicRange } } },
    });
  });

  it.each(['dolby-vision', 'unknown', 'sdr', ''])(
    'forbids local profile creation for %j dynamic range',
    (dynamicRange) => {
      expect(createGuidedUserDeviceDisplayProfile({
        installationId,
        environment,
        media: { ...media, dynamicRange },
        now,
        randomUUID: () => profileId,
      })).toMatchObject({ ok: false, reason: 'unsupported-dynamic-range' });
    },
  );

  it('enforces a positive lifetime of no more than 90 days', () => {
    for (const validForDays of [0, -1, 90.000001, Number.NaN]) {
      expect(createGuidedUserDeviceDisplayProfile({
        installationId,
        environment,
        media,
        now,
        validForDays,
        randomUUID: () => profileId,
      })).toMatchObject({ ok: false, reason: 'invalid-validity' });
    }

    const result = createGuidedUserDeviceDisplayProfile({
      installationId,
      environment,
      media,
      now,
      validForDays: 90,
      randomUUID: () => profileId,
    });
    expect(result.ok && new Date(result.profile.expiresAt).getTime() - new Date(now).getTime())
      .toBe(DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS);
  });

  it('rejects incomplete exact scope, environment and generated UUIDs', () => {
    expect(createGuidedUserDeviceDisplayProfile({
      installationId,
      environment,
      media: { ...media, profile: '' },
      now,
      randomUUID: () => profileId,
    })).toMatchObject({ ok: false, reason: 'invalid-media-scope' });
    expect(createGuidedUserDeviceDisplayProfile({
      installationId,
      environment: { ...environment, platform: '' },
      media,
      now,
      randomUUID: () => profileId,
    })).toMatchObject({ ok: false, reason: 'invalid-environment' });
    expect(createGuidedUserDeviceDisplayProfile({
      installationId: 'not-a-uuid',
      environment,
      media,
      now,
      randomUUID: () => profileId,
    })).toMatchObject({ ok: false, reason: 'invalid-installation-id' });
    expect(createGuidedUserDeviceDisplayProfile({
      installationId,
      environment,
      media,
      now,
      randomUUID: () => 'not-a-uuid',
    })).toMatchObject({ ok: false, reason: 'uuid-unavailable' });
  });
});

describe('device display capability resolution', () => {
  it('returns an in-memory identity grant that cannot survive copying or JSON persistence', () => {
    const storage = new MemoryStorage();
    const profile = storeProfile(storage);
    const result = resolveDeviceDisplayCapabilityGrant(storage, request());

    expect(result).toMatchObject({
      granted: true,
      grant: {
        kind: 'device-display-capability-grant',
        profileId,
        evidenceSource: 'guided-user',
        presentation: 'webxr',
        verifiedDynamicRange: 'hdr10',
        mediaId: media.mediaId,
        media: expect.objectContaining({ mediaId: media.mediaId, codec: 'hevc' }),
        binding: expect.objectContaining({
          installationId,
          browserProduct: 'chrome',
          browserEngine: 'webkit',
        }),
      },
    });
    expect(isDeviceDisplayCapabilityGrant(profile)).toBe(false);
    expect(result.granted && isDeviceDisplayCapabilityGrant(result.grant)).toBe(true);
    expect(result.granted && deviceDisplayCapabilityGrantMatchesRequest(
      result.grant,
      request(),
      new Date(now).getTime() + day,
    ))
      .toBe(true);
    expect(result.granted && Object.isFrozen(result.grant)).toBe(true);
    expect(result.granted && Object.isFrozen(result.grant.media)).toBe(true);
    expect(result.granted && Object.isFrozen(result.grant.binding)).toBe(true);
    expect(result.granted && isDeviceDisplayCapabilityGrant(
      JSON.parse(JSON.stringify(result.grant)),
    )).toBe(false);
    expect(result.granted && isDeviceDisplayCapabilityGrant({ ...result.grant })).toBe(false);
    expect(result.granted && isDeviceDisplayCapabilityGrant({
      ...result.grant,
      media: { ...result.grant.media, codec: 'av1' },
    })).toBe(false);

    if (result.granted) {
      expect(Reflect.set(result.grant.media, 'codec', 'av1')).toBe(false);
      expect(Reflect.set(result.grant.binding, 'origin', 'https://attacker.test')).toBe(false);
      expect(deviceDisplayCapabilityGrantMatchesRequest(
        result.grant,
        request(),
        new Date(now).getTime() + day,
      )).toBe(true);
    }
  });

  it('rechecks complete binding, media scope and current expiry at point of use', () => {
    const storage = new MemoryStorage();
    storeProfile(storage);
    const result = resolveDeviceDisplayCapabilityGrant(storage, request());
    if (!result.granted) throw new Error(result.detail);
    const validNow = new Date(now).getTime() + day;

    expect(deviceDisplayCapabilityGrantMatchesRequest(result.grant, request(), validNow)).toBe(true);
    expect(deviceDisplayCapabilityGrantMatchesRequest(result.grant, request({
      installationId: otherInstallationId,
    }), validNow)).toBe(false);
    expect(deviceDisplayCapabilityGrantMatchesRequest(result.grant, request({
      environment: { ...environment, browserMajor: environment.browserMajor + 1 },
    }), validNow)).toBe(false);
    expect(deviceDisplayCapabilityGrantMatchesRequest(result.grant, request({
      media: { ...media, colorTransfer: 'arib-std-b67' },
    }), validNow)).toBe(false);
    expect(deviceDisplayCapabilityGrantMatchesRequest(
      result.grant,
      request(),
      new Date(now).getTime() + 30 * day,
    )).toBe(false);
    expect(deviceDisplayCapabilityGrantMatchesRequest(
      result.grant,
      request(),
      'not-a-date',
    )).toBe(false);
  });

  it.each(['instrumented', 'vendor-attested'] as const)(
    'rejects unsigned localStorage evidence claiming %s verification',
    (source) => {
      const storage = new MemoryStorage();
      const profile = createProfile();
      initialize(storage);

      expect(upsertDeviceDisplayCapabilityProfile(
        storage,
        { ...profile, evidence: { ...profile.evidence, source } },
      )).toMatchObject({ ok: false, reason: 'invalid-profile' });

      storage.setItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY, JSON.stringify({
        schemaVersion: DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION,
        installationId,
        profiles: [{ ...profile, evidence: { ...profile.evidence, source } }],
      }));
      expect(readDeviceDisplayCapabilityStore(storage))
        .toMatchObject({ ok: false, reason: 'corrupt' });
      expect(resolveDeviceDisplayCapabilityGrant(storage, request()))
        .toMatchObject({ granted: false, reason: 'storage-corrupt' });
    },
  );

  it.each([
    ['origin-mismatch', { environment: { ...environment, origin: 'https://other.example.test' } }],
    ['browser-product-mismatch', {
      environment: { ...environment, browserProduct: 'safari' as const },
    }],
    ['browser-engine-mismatch', { environment: { ...environment, browserEngine: 'chromium' as const } }],
    ['browser-major-changed', { environment: { ...environment, browserMajor: 27 } }],
    ['platform-mismatch', { environment: { ...environment, platform: 'iOS' } }],
    ['pipeline-version-mismatch', {
      environment: { ...environment, pipelineVersion: 'webxr-video-v2' },
    }],
  ] as const)('fails closed with %s when the environment binding changes', (reason, overrides) => {
    const storage = new MemoryStorage();
    storeProfile(storage);
    expect(resolveDeviceDisplayCapabilityGrant(storage, request(overrides)))
      .toMatchObject({ granted: false, reason });
  });

  it('fails closed when the installation identity changes', () => {
    const storage = new MemoryStorage();
    storeProfile(storage);

    expect(resolveDeviceDisplayCapabilityGrant(storage, request({
      installationId: otherInstallationId,
    }))).toMatchObject({ granted: false, reason: 'installation-mismatch' });
  });

  it.each([
    ['size', media.size + 1],
    ['modifiedAt', '2026-01-01T00:00:00.000Z'],
    ['codec', 'av1'],
    ['profile', 'main 12'],
    ['level', 156],
    ['pixelFormat', 'yuv444p10le'],
    ['bitDepth', 12],
    ['dynamicRange', 'hlg'],
    ['colorPrimaries', 'bt709'],
    ['colorTransfer', 'bt709'],
    ['colorSpace', 'bt709'],
    ['colorRange', 'pc'],
    ['container', 'mov,mp4,m4a,3gp,3g2,mj2'],
    ['width', 4096],
    ['height', 2048],
    ['fps', 60],
    ['projection', 'equirect360'],
    ['stereo', 'tb'],
  ] as const)('invalidates the exact-media grant when %s changes', (field, value) => {
    const storage = new MemoryStorage();
    storeProfile(storage);
    expect(resolveDeviceDisplayCapabilityGrant(storage, request({
      media: { ...media, [field]: value },
    }))).toMatchObject({ granted: false, reason: 'media-mismatch' });
  });

  it('binds media ID and does not search another resource fingerprint', () => {
    const storage = new MemoryStorage();
    storeProfile(storage);
    expect(resolveDeviceDisplayCapabilityGrant(storage, request({
      media: { ...media, mediaId: 'movie-2' },
    }))).toMatchObject({ granted: false, reason: 'no-profile' });
  });

  it('fails closed before creation time, at expiry, and after revocation', () => {
    const storage = new MemoryStorage();
    storeProfile(storage);

    expect(resolveDeviceDisplayCapabilityGrant(storage, request({
      now: new Date(now).getTime() - 1,
    }))).toMatchObject({ granted: false, reason: 'not-yet-valid' });
    expect(resolveDeviceDisplayCapabilityGrant(storage, request({
      now: new Date(now).getTime() + 30 * day,
    }))).toMatchObject({ granted: false, reason: 'expired' });

    expect(revokeDeviceDisplayCapabilityProfile(storage, profileId, new Date(now).getTime() + day).ok)
      .toBe(true);
    expect(resolveDeviceDisplayCapabilityGrant(storage, request()))
      .toMatchObject({ granted: false, reason: 'revoked' });
  });

  it.each(['dolby-vision', 'unknown', 'sdr'])(
    'never resolves a local grant for %s media',
    (dynamicRange) => {
      const storage = new MemoryStorage();
      storeProfile(storage);
      expect(resolveDeviceDisplayCapabilityGrant(storage, request({
        media: { ...media, dynamicRange },
      }))).toMatchObject({ granted: false, reason: 'unsupported-dynamic-range' });
    },
  );

  it('uses another matching profile when an older candidate is revoked', () => {
    const storage = new MemoryStorage();
    const revoked = { ...createProfile(), revokedAt: '2026-01-02T00:00:00.000Z' };
    const active = createProfile({
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
    });
    initialize(storage);
    expect(upsertDeviceDisplayCapabilityProfile(storage, revoked).ok).toBe(true);
    expect(upsertDeviceDisplayCapabilityProfile(storage, active).ok).toBe(true);

    expect(resolveDeviceDisplayCapabilityGrant(storage, request()))
      .toMatchObject({ granted: true, grant: { profileId: active.id } });
  });
});

describe('mutation safety', () => {
  it('rejects cross-installation upserts and missing-profile revocation', () => {
    const storage = new MemoryStorage();
    initialize(storage);
    const profile = createProfile({ installationId: otherInstallationId });

    expect(upsertDeviceDisplayCapabilityProfile(storage, profile))
      .toMatchObject({ ok: false, reason: 'installation-mismatch' });
    expect(revokeDeviceDisplayCapabilityProfile(storage, profileId, now))
      .toMatchObject({ ok: false, reason: 'profile-not-found' });
  });

  it('rejects a revocation timestamp before profile creation', () => {
    const storage = new MemoryStorage();
    storeProfile(storage);

    expect(revokeDeviceDisplayCapabilityProfile(
      storage,
      profileId,
      new Date(now).getTime() - 1,
    )).toMatchObject({ ok: false, reason: 'invalid-time' });
    expect(resolveDeviceDisplayCapabilityGrant(storage, request())).toMatchObject({ granted: true });
  });
});
