import type { Projection, StereoLayout } from '../../server/types';

export const DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY = 'localis.deviceDisplayCapabilities.v1';
export const DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEVICE_DISPLAY_PIPELINE_VERSION = 'webxr-video-v1';

export type DeviceDisplayEvidenceSource =
  | 'guided-user'
  | 'instrumented'
  | 'vendor-attested';

export type VerifiedDisplayDynamicRange = 'hdr10' | 'hlg' | 'sdr10';
export type DeviceBrowserEngine = 'chromium' | 'webkit' | 'gecko';
export type DeviceBrowserProduct =
  | 'meta-quest'
  | 'pico'
  | 'edge'
  | 'chrome'
  | 'safari'
  | 'firefox';
export type DeviceDisplayPresentation = 'webxr';

export interface DeviceDisplayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DeviceDisplayEnvironment {
  origin: string;
  browserProduct: DeviceBrowserProduct;
  browserEngine: DeviceBrowserEngine;
  browserMajor: number;
  platform: string;
  presentation: DeviceDisplayPresentation;
  pipelineVersion: string;
}

/**
 * Every field is part of the scope. A grant for one encode, projection or
 * stereo layout is deliberately not transferable to another media resource.
 */
export interface ExactDisplayMediaInput {
  mediaId: string;
  size: number;
  modifiedAt: string;
  codec: string;
  profile: string;
  level: number;
  pixelFormat: string;
  bitDepth: number;
  dynamicRange: string;
  colorPrimaries: string;
  colorTransfer: string;
  colorSpace: string;
  colorRange: string;
  container: string;
  width: number;
  height: number;
  fps: number;
  projection: Projection;
  stereo: StereoLayout;
}

export interface ExactDisplayMediaScope
  extends Omit<ExactDisplayMediaInput, 'dynamicRange'> {
  dynamicRange: VerifiedDisplayDynamicRange;
}

export interface DeviceDisplayCapabilityBinding extends DeviceDisplayEnvironment {
  installationId: string;
}

export interface PersistedDeviceDisplayCapabilityProfileV1 {
  id: string;
  binding: DeviceDisplayCapabilityBinding;
  scope: {
    kind: 'exact-media';
    media: ExactDisplayMediaScope;
  };
  evidence: {
    source: DeviceDisplayEvidenceSource;
    recordedAt: string;
  };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface PersistedDeviceDisplayCapabilityStoreV1 {
  schemaVersion: typeof DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION;
  installationId: string;
  profiles: PersistedDeviceDisplayCapabilityProfileV1[];
}

export type DeviceDisplayStoreFailureReason =
  | 'missing'
  | 'corrupt'
  | 'unknown-schema'
  | 'storage-error';

export type DeviceDisplayStoreReadResult =
  | { ok: true; store: PersistedDeviceDisplayCapabilityStoreV1 }
  | { ok: false; reason: DeviceDisplayStoreFailureReason; detail: string };

export type DeviceDisplayMutationFailureReason =
  | DeviceDisplayStoreFailureReason
  | 'invalid-profile'
  | 'installation-mismatch'
  | 'profile-not-found'
  | 'invalid-time'
  | 'uuid-unavailable';

export type DeviceDisplayMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DeviceDisplayMutationFailureReason; detail: string };

export type CreateGuidedDisplayProfileFailureReason =
  | 'invalid-installation-id'
  | 'invalid-environment'
  | 'invalid-media-scope'
  | 'unsupported-dynamic-range'
  | 'invalid-validity'
  | 'uuid-unavailable';

export type CreateGuidedDisplayProfileResult =
  | { ok: true; profile: PersistedDeviceDisplayCapabilityProfileV1 }
  | { ok: false; reason: CreateGuidedDisplayProfileFailureReason; detail: string };

// Grants are capabilities, not serializable claims. Only object identities
// registered here by the resolver are accepted as authority. A private symbol
// is insufficient because object spread copies enumerable symbol properties.
const issuedDeviceDisplayCapabilityGrants = new WeakSet<object>();

/**
 * A grant exists only in memory after resolution. Its identity is registered
 * in a module-private WeakSet, so JSON, object spread and structural lookalikes
 * are never themselves authority.
 */
export interface DeviceDisplayCapabilityGrant {
  readonly kind: 'device-display-capability-grant';
  readonly profileId: string;
  readonly evidenceSource: DeviceDisplayEvidenceSource;
  readonly presentation: DeviceDisplayPresentation;
  readonly verifiedDynamicRange: VerifiedDisplayDynamicRange;
  readonly mediaId: string;
  /** Canonical exact-media scope rechecked by the playback decision. */
  readonly media: Readonly<ExactDisplayMediaScope>;
  /** Canonical installation and environment binding for caller-side rechecks. */
  readonly binding: Readonly<DeviceDisplayCapabilityBinding>;
  readonly expiresAt: string;
}

export type DeviceDisplayResolveFailureReason =
  | 'no-profile'
  | 'storage-corrupt'
  | 'unknown-schema'
  | 'storage-error'
  | 'invalid-request'
  | 'unsupported-dynamic-range'
  | 'installation-mismatch'
  | 'origin-mismatch'
  | 'browser-product-mismatch'
  | 'browser-engine-mismatch'
  | 'browser-major-changed'
  | 'platform-mismatch'
  | 'presentation-mismatch'
  | 'pipeline-version-mismatch'
  | 'media-mismatch'
  | 'not-yet-valid'
  | 'expired'
  | 'revoked';

export type DeviceDisplayCapabilityResolution =
  | { granted: true; grant: DeviceDisplayCapabilityGrant }
  | { granted: false; reason: DeviceDisplayResolveFailureReason; detail: string };

export interface DeviceDisplayCapabilityRequest {
  installationId: string;
  environment: DeviceDisplayEnvironment;
  media: ExactDisplayMediaInput;
  now?: Date | number | string;
}

export interface CreateGuidedDisplayProfileInput {
  installationId: string;
  environment: DeviceDisplayEnvironment;
  media: ExactDisplayMediaInput;
  now?: Date | number | string;
  validForDays?: number;
  randomUUID?: () => string;
}

type Validation = { ok: true } | { ok: false; detail: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projections = new Set<Projection>(['flat', 'equirect180', 'equirect360']);
const stereoLayouts = new Set<StereoLayout>(['mono', 'sbs', 'tb']);
// V1 localStorage has no signature or trusted issuer. It may persist only the
// locally authored guided-user evidence. Future instrumented/vendor imports
// require a separately authenticated format; accepting those labels from
// editable browser JSON would let any page/user forge a "verified" result.
const locallyPersistableEvidenceSources = new Set<DeviceDisplayEvidenceSource>(['guided-user']);
const browserEngines = new Set<DeviceBrowserEngine>(['chromium', 'webkit', 'gecko']);
const browserProducts = new Set<DeviceBrowserProduct>([
  'meta-quest',
  'pico',
  'edge',
  'chrome',
  'safari',
  'firefox',
]);
const verifiedRanges = new Set<VerifiedDisplayDynamicRange>(['hdr10', 'hlg', 'sdr10']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isFiniteNumber(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown, maximumLength = 512): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength;
}

function dateMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return undefined;
  }
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function normalizedDate(value: Date | number | string): string | undefined {
  const milliseconds = dateMilliseconds(value);
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

function normalizedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function normalizedToken(value: string) {
  return value.trim().toLowerCase();
}

function normalizeMediaScope(media: ExactDisplayMediaInput): ExactDisplayMediaScope | undefined {
  if (typeof media.dynamicRange !== 'string') return undefined;
  const dynamicRange = normalizedToken(media.dynamicRange) as VerifiedDisplayDynamicRange;
  if (!verifiedRanges.has(dynamicRange)) return undefined;
  if (!isNonEmptyString(media.mediaId)
    || !Number.isSafeInteger(media.size)
    || media.size < 0
    || !normalizedDate(media.modifiedAt)
    || !isNonEmptyString(media.codec, 80)
    || !isNonEmptyString(media.profile, 80)
    || !isFiniteNumber(media.level)
    || !isNonEmptyString(media.pixelFormat, 80)
    || !isPositiveInteger(media.bitDepth)
    || !isNonEmptyString(media.colorPrimaries, 80)
    || !isNonEmptyString(media.colorTransfer, 80)
    || !isNonEmptyString(media.colorSpace, 80)
    || !isNonEmptyString(media.colorRange, 80)
    || !isNonEmptyString(media.container, 160)
    || !isPositiveInteger(media.width)
    || !isPositiveInteger(media.height)
    || !isFiniteNumber(media.fps, Number.EPSILON)
    || !projections.has(media.projection)
    || !stereoLayouts.has(media.stereo)) {
    return undefined;
  }

  return {
    mediaId: media.mediaId.trim(),
    size: media.size,
    modifiedAt: normalizedDate(media.modifiedAt)!,
    codec: normalizedToken(media.codec),
    profile: normalizedToken(media.profile),
    level: media.level,
    pixelFormat: normalizedToken(media.pixelFormat),
    bitDepth: media.bitDepth,
    dynamicRange,
    colorPrimaries: normalizedToken(media.colorPrimaries),
    colorTransfer: normalizedToken(media.colorTransfer),
    colorSpace: normalizedToken(media.colorSpace),
    colorRange: normalizedToken(media.colorRange),
    container: normalizedToken(media.container),
    width: media.width,
    height: media.height,
    fps: media.fps,
    projection: media.projection,
    stereo: media.stereo,
  };
}

function normalizeEnvironment(environment: DeviceDisplayEnvironment): DeviceDisplayEnvironment | undefined {
  const origin = normalizedOrigin(environment.origin);
  if (!origin
    || !browserProducts.has(environment.browserProduct)
    || !browserEngines.has(environment.browserEngine)
    || !isPositiveInteger(environment.browserMajor)
    || !isNonEmptyString(environment.platform, 80)
    || environment.presentation !== 'webxr'
    || !isNonEmptyString(environment.pipelineVersion, 80)) {
    return undefined;
  }

  const productEngineIsCoherent = environment.browserProduct === 'meta-quest'
    || environment.browserProduct === 'pico'
    ? environment.browserEngine === 'chromium'
    : environment.browserProduct === 'safari'
      ? environment.browserEngine === 'webkit'
      : environment.browserProduct === 'firefox'
        ? environment.browserEngine === 'gecko' || environment.browserEngine === 'webkit'
        : environment.browserEngine === 'chromium' || environment.browserEngine === 'webkit';
  if (!productEngineIsCoherent) return undefined;

  return {
    origin,
    browserProduct: environment.browserProduct,
    browserEngine: environment.browserEngine,
    browserMajor: environment.browserMajor,
    platform: normalizedToken(environment.platform),
    presentation: 'webxr',
    pipelineVersion: environment.pipelineVersion.trim(),
  };
}

function validateMediaScope(value: unknown): Validation {
  if (!isRecord(value)) return { ok: false, detail: 'exact-media scope is not an object' };
  const normalized = normalizeMediaScope(value as unknown as ExactDisplayMediaInput);
  if (!normalized) return { ok: false, detail: 'exact-media scope is incomplete or invalid' };

  for (const key of Object.keys(normalized) as Array<keyof ExactDisplayMediaScope>) {
    if (value[key] !== normalized[key]) {
      return { ok: false, detail: `exact-media field ${key} is not canonical` };
    }
  }
  return { ok: true };
}

function validateBinding(value: unknown): Validation {
  if (!isRecord(value) || !isUuid(value.installationId)) {
    return { ok: false, detail: 'profile binding has no valid installation UUID' };
  }
  const normalized = normalizeEnvironment(value as unknown as DeviceDisplayEnvironment);
  if (!normalized) return { ok: false, detail: 'profile environment binding is invalid' };
  for (const key of Object.keys(normalized) as Array<keyof DeviceDisplayEnvironment>) {
    if (value[key] !== normalized[key]) {
      return { ok: false, detail: `environment field ${key} is not canonical` };
    }
  }
  return { ok: true };
}

function validateProfile(value: unknown, installationId?: string): Validation {
  if (!isRecord(value) || !isUuid(value.id)) {
    return { ok: false, detail: 'profile has no valid UUID' };
  }
  const binding = validateBinding(value.binding);
  if (!binding.ok) return binding;
  const bindingValue = value.binding as unknown as DeviceDisplayCapabilityBinding;
  if (installationId && bindingValue.installationId !== installationId) {
    return { ok: false, detail: 'profile installation UUID does not match its store' };
  }
  if (!isRecord(value.scope) || value.scope.kind !== 'exact-media') {
    return { ok: false, detail: 'only exact-media scope is supported' };
  }
  const media = validateMediaScope(value.scope.media);
  if (!media.ok) return media;
  if (!isRecord(value.evidence)
    || !locallyPersistableEvidenceSources.has(value.evidence.source as DeviceDisplayEvidenceSource)
    || normalizedDate(value.evidence.recordedAt as string) !== value.evidence.recordedAt) {
    return { ok: false, detail: 'profile evidence is invalid' };
  }

  const created = dateMilliseconds(value.createdAt);
  const expires = dateMilliseconds(value.expiresAt);
  const recorded = dateMilliseconds(value.evidence.recordedAt);
  if (created === undefined
    || expires === undefined
    || recorded === undefined
    || normalizedDate(value.createdAt as string) !== value.createdAt
    || normalizedDate(value.expiresAt as string) !== value.expiresAt
    || expires <= created
    || expires - created > DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS
    || recorded < created
    || recorded > expires) {
    return { ok: false, detail: 'profile validity window is invalid or exceeds 90 days' };
  }

  if (value.revokedAt !== null) {
    const revoked = dateMilliseconds(value.revokedAt);
    if (revoked === undefined
      || normalizedDate(value.revokedAt as string) !== value.revokedAt
      || revoked < created) {
      return { ok: false, detail: 'profile revocation timestamp is invalid' };
    }
  }
  return { ok: true };
}

function validateStore(value: unknown): Validation {
  if (!isRecord(value)
    || value.schemaVersion !== DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION
    || !isUuid(value.installationId)
    || !Array.isArray(value.profiles)) {
    return { ok: false, detail: 'device display capability store is malformed' };
  }

  const profileIds = new Set<string>();
  for (const profile of value.profiles) {
    const validation = validateProfile(profile, value.installationId);
    if (!validation.ok) return validation;
    const id = (profile as PersistedDeviceDisplayCapabilityProfileV1).id;
    if (profileIds.has(id)) return { ok: false, detail: 'profile UUID is duplicated' };
    profileIds.add(id);
  }
  return { ok: true };
}

function defaultRandomUUID() {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

function failMutation(
  reason: DeviceDisplayMutationFailureReason,
  detail: string,
): DeviceDisplayMutationResult<never> {
  return { ok: false, reason, detail };
}

export function readDeviceDisplayCapabilityStore(
  storage: DeviceDisplayStorage,
): DeviceDisplayStoreReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY);
  } catch (cause) {
    return {
      ok: false,
      reason: 'storage-error',
      detail: cause instanceof Error ? cause.message : 'localStorage read failed',
    };
  }
  if (serialized === null) {
    return { ok: false, reason: 'missing', detail: 'No device display capability store exists.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'Stored capability JSON cannot be parsed.' };
  }
  if (isRecord(parsed)
    && Object.hasOwn(parsed, 'schemaVersion')
    && parsed.schemaVersion !== DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'unknown-schema',
      detail: `Unsupported device display capability schema ${String(parsed.schemaVersion)}.`,
    };
  }
  const validation = validateStore(parsed);
  if (!validation.ok) return { ok: false, reason: 'corrupt', detail: validation.detail };
  return { ok: true, store: parsed as unknown as PersistedDeviceDisplayCapabilityStoreV1 };
}

export function writeDeviceDisplayCapabilityStore(
  storage: DeviceDisplayStorage,
  store: PersistedDeviceDisplayCapabilityStoreV1,
): DeviceDisplayMutationResult<PersistedDeviceDisplayCapabilityStoreV1> {
  const validation = validateStore(store);
  if (!validation.ok) return failMutation('invalid-profile', validation.detail);
  try {
    storage.setItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY, JSON.stringify(store));
    return { ok: true, value: store };
  } catch (cause) {
    return failMutation(
      'storage-error',
      cause instanceof Error ? cause.message : 'localStorage write failed',
    );
  }
}

/**
 * Creates the installation identity only when no v1 store exists. Corrupt or
 * future stores must be explicitly reset instead of being silently trusted or
 * overwritten.
 */
export function getOrCreateDeviceDisplayInstallationId(
  storage: DeviceDisplayStorage,
  randomUUID: () => string = defaultRandomUUID,
): DeviceDisplayMutationResult<string> {
  const existing = readDeviceDisplayCapabilityStore(storage);
  if (existing.ok) return { ok: true, value: existing.store.installationId };
  if (existing.reason !== 'missing') return failMutation(existing.reason, existing.detail);

  let installationId: string;
  try {
    installationId = randomUUID();
  } catch (cause) {
    return failMutation(
      'uuid-unavailable',
      cause instanceof Error ? cause.message : 'UUID generation failed',
    );
  }
  if (!isUuid(installationId)) return failMutation('uuid-unavailable', 'Generated installation ID is not a UUID.');

  const store: PersistedDeviceDisplayCapabilityStoreV1 = {
    schemaVersion: DEVICE_DISPLAY_CAPABILITY_SCHEMA_VERSION,
    installationId,
    profiles: [],
  };
  const written = writeDeviceDisplayCapabilityStore(storage, store);
  return written.ok ? { ok: true, value: installationId } : written;
}

/**
 * The only local authoring API. Unsigned v1 localStorage accepts guided-user
 * evidence only; stronger evidence requires a future authenticated format.
 */
export function createGuidedUserDeviceDisplayProfile(
  input: CreateGuidedDisplayProfileInput,
): CreateGuidedDisplayProfileResult {
  if (!isUuid(input.installationId)) {
    return { ok: false, reason: 'invalid-installation-id', detail: 'Installation ID must be a UUID.' };
  }
  const environment = normalizeEnvironment(input.environment);
  if (!environment) {
    return { ok: false, reason: 'invalid-environment', detail: 'Display environment binding is incomplete.' };
  }
  const requestedRange = normalizedToken(input.media.dynamicRange);
  if (!verifiedRanges.has(requestedRange as VerifiedDisplayDynamicRange)) {
    return {
      ok: false,
      reason: 'unsupported-dynamic-range',
      detail: 'Only exact HDR10, HLG and 10-bit SDR media can receive a local guided grant.',
    };
  }
  const media = normalizeMediaScope(input.media);
  if (!media) {
    return { ok: false, reason: 'invalid-media-scope', detail: 'Exact media metadata is incomplete or invalid.' };
  }

  const now = normalizedDate(input.now ?? Date.now());
  const validForDays = input.validForDays ?? 90;
  if (!now
    || !Number.isFinite(validForDays)
    || validForDays <= 0
    || validForDays * 24 * 60 * 60 * 1_000 > DEVICE_DISPLAY_CAPABILITY_MAX_AGE_MS) {
    return { ok: false, reason: 'invalid-validity', detail: 'Validity must be greater than zero and at most 90 days.' };
  }

  let id: string;
  try {
    id = (input.randomUUID ?? defaultRandomUUID)();
  } catch (cause) {
    return {
      ok: false,
      reason: 'uuid-unavailable',
      detail: cause instanceof Error ? cause.message : 'UUID generation failed',
    };
  }
  if (!isUuid(id)) {
    return { ok: false, reason: 'uuid-unavailable', detail: 'Generated profile ID is not a UUID.' };
  }

  const expiresAt = new Date(new Date(now).getTime() + validForDays * 24 * 60 * 60 * 1_000).toISOString();
  return {
    ok: true,
    profile: {
      id,
      binding: { installationId: input.installationId, ...environment },
      scope: { kind: 'exact-media', media },
      evidence: { source: 'guided-user', recordedAt: now },
      createdAt: now,
      expiresAt,
      revokedAt: null,
    },
  };
}

export function upsertDeviceDisplayCapabilityProfile(
  storage: DeviceDisplayStorage,
  profile: PersistedDeviceDisplayCapabilityProfileV1,
): DeviceDisplayMutationResult<PersistedDeviceDisplayCapabilityStoreV1> {
  const read = readDeviceDisplayCapabilityStore(storage);
  if (!read.ok) return failMutation(read.reason, read.detail);
  const validation = validateProfile(profile, read.store.installationId);
  if (!validation.ok) {
    const binding = isRecord(profile.binding) ? profile.binding.installationId : undefined;
    return failMutation(
      binding !== read.store.installationId ? 'installation-mismatch' : 'invalid-profile',
      validation.detail,
    );
  }

  // Re-confirming the same exact media on the same display path supersedes the
  // previous local confirmation instead of growing an unbounded history. A
  // different media fingerprint or environment remains independently scoped.
  const profiles = read.store.profiles.filter((candidate) => (
    candidate.id !== profile.id
    && !(candidate.evidence.source === 'guided-user'
      && profile.evidence.source === 'guided-user'
      && bindingsEqual(candidate.binding, profile.binding)
      && mediaScopesEqual(candidate.scope.media, profile.scope.media))
  ));
  profiles.push(profile);
  return writeDeviceDisplayCapabilityStore(storage, { ...read.store, profiles });
}

export function revokeDeviceDisplayCapabilityProfile(
  storage: DeviceDisplayStorage,
  profileId: string,
  now: Date | number | string = Date.now(),
): DeviceDisplayMutationResult<PersistedDeviceDisplayCapabilityStoreV1> {
  const read = readDeviceDisplayCapabilityStore(storage);
  if (!read.ok) return failMutation(read.reason, read.detail);
  const index = read.store.profiles.findIndex((profile) => profile.id === profileId);
  if (index === -1) return failMutation('profile-not-found', 'No profile with that UUID exists.');
  const revokedAt = normalizedDate(now);
  if (!revokedAt || new Date(revokedAt).getTime() < new Date(read.store.profiles[index].createdAt).getTime()) {
    return failMutation('invalid-time', 'Revocation cannot predate profile creation.');
  }

  const profiles = [...read.store.profiles];
  profiles[index] = { ...profiles[index], revokedAt };
  return writeDeviceDisplayCapabilityStore(storage, { ...read.store, profiles });
}

export function resetDeviceDisplayCapabilityStore(
  storage: DeviceDisplayStorage,
): DeviceDisplayMutationResult<undefined> {
  try {
    storage.removeItem(DEVICE_DISPLAY_CAPABILITY_STORAGE_KEY);
    return { ok: true, value: undefined };
  } catch (cause) {
    return failMutation(
      'storage-error',
      cause instanceof Error ? cause.message : 'localStorage reset failed',
    );
  }
}

function mediaScopesEqual(left: ExactDisplayMediaScope, right: ExactDisplayMediaScope) {
  return left.mediaId === right.mediaId
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.codec === right.codec
    && left.profile === right.profile
    && left.level === right.level
    && left.pixelFormat === right.pixelFormat
    && left.bitDepth === right.bitDepth
    && left.dynamicRange === right.dynamicRange
    && left.colorPrimaries === right.colorPrimaries
    && left.colorTransfer === right.colorTransfer
    && left.colorSpace === right.colorSpace
    && left.colorRange === right.colorRange
    && left.container === right.container
    && left.width === right.width
    && left.height === right.height
    && left.fps === right.fps
    && left.projection === right.projection
    && left.stereo === right.stereo;
}

function environmentsEqual(
  left: DeviceDisplayEnvironment,
  right: DeviceDisplayEnvironment,
) {
  return left.origin === right.origin
    && left.browserProduct === right.browserProduct
    && left.browserEngine === right.browserEngine
    && left.browserMajor === right.browserMajor
    && left.platform === right.platform
    && left.presentation === right.presentation
    && left.pipelineVersion === right.pipelineVersion;
}

function bindingsEqual(
  left: DeviceDisplayCapabilityBinding,
  right: DeviceDisplayCapabilityBinding,
) {
  return left.installationId === right.installationId && environmentsEqual(left, right);
}

function failedResolution(
  reason: DeviceDisplayResolveFailureReason,
  detail: string,
): DeviceDisplayCapabilityResolution {
  return { granted: false, reason, detail };
}

function bindingFailure(
  binding: DeviceDisplayCapabilityBinding,
  request: DeviceDisplayCapabilityRequest,
  environment: DeviceDisplayEnvironment,
): DeviceDisplayCapabilityResolution | undefined {
  if (binding.installationId !== request.installationId) {
    return failedResolution('installation-mismatch', 'The profile belongs to another Localis installation.');
  }
  if (binding.origin !== environment.origin) {
    return failedResolution('origin-mismatch', 'The profile belongs to another origin.');
  }
  if (binding.browserProduct !== environment.browserProduct) {
    return failedResolution('browser-product-mismatch', 'The browser product has changed.');
  }
  if (binding.browserEngine !== environment.browserEngine) {
    return failedResolution('browser-engine-mismatch', 'The browser engine has changed.');
  }
  if (binding.browserMajor !== environment.browserMajor) {
    return failedResolution('browser-major-changed', 'The browser major version has changed and requires re-verification.');
  }
  if (binding.platform !== environment.platform) {
    return failedResolution('platform-mismatch', 'The operating platform has changed.');
  }
  if (binding.presentation !== environment.presentation) {
    return failedResolution('presentation-mismatch', 'The verified presentation path is not the current path.');
  }
  if (binding.pipelineVersion !== environment.pipelineVersion) {
    return failedResolution('pipeline-version-mismatch', 'The WebXR video pipeline version has changed.');
  }
  return undefined;
}

export function resolveDeviceDisplayCapabilityGrant(
  storage: DeviceDisplayStorage,
  request: DeviceDisplayCapabilityRequest,
): DeviceDisplayCapabilityResolution {
  const read = readDeviceDisplayCapabilityStore(storage);
  if (!read.ok) {
    if (read.reason === 'missing') return failedResolution('no-profile', read.detail);
    if (read.reason === 'corrupt') return failedResolution('storage-corrupt', read.detail);
    return failedResolution(read.reason, read.detail);
  }
  if (!isUuid(request.installationId)) {
    return failedResolution('invalid-request', 'Current installation ID is not a UUID.');
  }
  if (read.store.installationId !== request.installationId) {
    return failedResolution('installation-mismatch', 'Stored capability data belongs to another installation.');
  }
  const environment = normalizeEnvironment(request.environment);
  if (!environment) return failedResolution('invalid-request', 'Current display environment is incomplete.');
  const requestedRange = normalizedToken(request.media.dynamicRange);
  if (!verifiedRanges.has(requestedRange as VerifiedDisplayDynamicRange)) {
    return failedResolution(
      'unsupported-dynamic-range',
      'Dolby Vision and unknown display ranges cannot use a local display grant.',
    );
  }
  const media = normalizeMediaScope(request.media);
  if (!media) return failedResolution('invalid-request', 'Current exact media metadata is incomplete.');
  const now = dateMilliseconds(request.now ?? Date.now());
  if (now === undefined) return failedResolution('invalid-request', 'Current time is invalid.');

  const sameId = [...read.store.profiles]
    .reverse()
    .filter((profile) => profile.scope.media.mediaId === media.mediaId);
  if (sameId.length === 0) return failedResolution('no-profile', 'No display profile exists for this media ID.');

  let firstFailure: DeviceDisplayCapabilityResolution | undefined;
  for (const profile of sameId) {
    let failure: DeviceDisplayCapabilityResolution | undefined;
    if (!mediaScopesEqual(profile.scope.media, media)) {
      failure = failedResolution('media-mismatch', 'The media fingerprint changed and requires re-verification.');
    } else if (profile.revokedAt !== null) {
      failure = failedResolution('revoked', 'This display profile was revoked.');
    } else if (now < new Date(profile.createdAt).getTime()) {
      failure = failedResolution('not-yet-valid', 'This display profile is not valid yet.');
    } else if (now >= new Date(profile.expiresAt).getTime()) {
      failure = failedResolution('expired', 'This display profile expired and requires re-verification.');
    } else {
      failure = bindingFailure(profile.binding, request, environment);
    }

    if (failure) {
      firstFailure ??= failure;
      continue;
    }

    const grant: DeviceDisplayCapabilityGrant = Object.freeze({
      kind: 'device-display-capability-grant',
      profileId: profile.id,
      evidenceSource: profile.evidence.source,
      presentation: profile.binding.presentation,
      verifiedDynamicRange: profile.scope.media.dynamicRange,
      mediaId: profile.scope.media.mediaId,
      media: Object.freeze({ ...profile.scope.media }),
      binding: Object.freeze({ ...profile.binding }),
      expiresAt: profile.expiresAt,
    });
    issuedDeviceDisplayCapabilityGrants.add(grant);
    return { granted: true, grant };
  }
  return firstFailure ?? failedResolution('no-profile', 'No applicable display profile exists.');
}

export function isDeviceDisplayCapabilityGrant(value: unknown): value is DeviceDisplayCapabilityGrant {
  return isRecord(value) && issuedDeviceDisplayCapabilityGrants.has(value);
}

/**
 * Revalidates a resolver-issued capability against the exact request at its
 * point of use. This intentionally authenticates object identity before
 * comparing every binding and media field, and it checks expiry again so a
 * caller cannot retain a once-valid grant indefinitely.
 */
export function deviceDisplayCapabilityGrantMatchesRequest(
  grant: unknown,
  request: DeviceDisplayCapabilityRequest,
  nowOverride?: Date | number | string,
): grant is DeviceDisplayCapabilityGrant {
  if (!isDeviceDisplayCapabilityGrant(grant)
    || !Object.isFrozen(grant)
    || !Object.isFrozen(grant.media)
    || !Object.isFrozen(grant.binding)
    || !isUuid(request.installationId)) {
    return false;
  }

  const environment = normalizeEnvironment(request.environment);
  const media = normalizeMediaScope(request.media);
  // A request may retain the timestamp that was used to resolve it. Never use
  // that historical value here: point-of-use validation must check real time.
  // The explicit override exists only for deterministic callers/tests.
  const now = dateMilliseconds(nowOverride ?? Date.now());
  const expiresAt = dateMilliseconds(grant.expiresAt);
  if (!environment
    || !media
    || now === undefined
    || expiresAt === undefined
    || normalizedDate(grant.expiresAt) !== grant.expiresAt
    || now >= expiresAt) {
    return false;
  }

  return grant.kind === 'device-display-capability-grant'
    && grant.binding.installationId === request.installationId
    && environmentsEqual(grant.binding, environment)
    && grant.mediaId === media.mediaId
    && grant.verifiedDynamicRange === media.dynamicRange
    && mediaScopesEqual(grant.media, media);
}
