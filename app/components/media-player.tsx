'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext currently duplicates React context when next/link is optimized in development. */

import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PlaybackProgress, PublicMediaItem } from '@/server/types';
import type { ServerSuperResolutionLevel, ServerSuperResolutionPlan } from '@/server/super-resolution';
import { XrVideoStage, type XrDiagnostics, type XrVideoOptions } from '@/app/lib/xr-video-stage';
import { chooseHlsTransport } from '@/app/lib/hls-transport';
import { savedServerSuperResolution } from '@/app/lib/server-super-resolution-preference';
import {
  probeBrowserMediaCapability,
  type BrowserMediaCapabilityResult,
  type ClientMediaDecodingConfiguration,
} from '@/app/lib/browser-media-capability';
import {
  createGuidedUserDeviceDisplayProfile,
  getOrCreateDeviceDisplayInstallationId,
  resetDeviceDisplayCapabilityStore,
  resolveDeviceDisplayCapabilityGrant,
  revokeDeviceDisplayCapabilityProfile,
  upsertDeviceDisplayCapabilityProfile,
  type DeviceDisplayCapabilityResolution,
  type DeviceDisplayEnvironment,
  type DeviceDisplayStorage,
  type ExactDisplayMediaInput,
  type VerifiedDisplayDynamicRange,
} from '@/app/lib/device-display-capability';
import {
  buildDeviceDisplayEnvironment,
  buildExactDisplayMediaInput,
  type DeviceBrowserName,
} from '@/app/lib/device-display-environment';
import {
  describePlaybackPath,
  type PlaybackPresentationAssurance,
} from '@/app/lib/playback-path-label';
import { hlsPlaybackUrls } from '@/app/lib/hls-playback-url';
import {
  qualifiesXrOriginalSample,
  type XrOriginalSamplePoint,
} from '@/app/lib/xr-original-sample';

interface TranscodeStatus {
  state: string;
  mode: string;
  forcedCompatibility?: boolean;
  encoder: string;
  progressSeconds: number;
  error?: string;
  superResolution: ServerSuperResolutionLevel;
  plan: ServerSuperResolutionPlan;
  durationSeconds?: number;
  progressPercent?: number;
  speed?: number;
  etaSeconds?: number;
  activeSegmentPercent?: number;
  activeSegmentStartSeconds?: number;
  activeEtaSeconds?: number;
  generatedSegments?: number;
  totalSegments?: number;
  generationState?: 'waiting' | 'processing' | 'complete' | 'failed';
  generationStage?: 'extracting' | 'enhancing' | 'encoding';
  enhancementBackend?: string;
  strategy?: 'eager' | 'on-demand' | 'precompute';
  seekable?: boolean;
}

interface MediaResponse {
  item: PublicMediaItem;
  progress?: PlaybackProgress;
  transcode: TranscodeStatus;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.message || body.error || `HTTP ${response.status}`));
  return body as T;
}

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor(whole / 60);
  if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

function savedSuperResolution(): ServerSuperResolutionLevel {
  return savedServerSuperResolution(typeof window === 'undefined' ? undefined : window.localStorage);
}

interface ResolvedDisplayProfileState {
  status: 'resolved';
  installationId: string;
  environment: DeviceDisplayEnvironment;
  media: ExactDisplayMediaInput;
  browserName: DeviceBrowserName;
  resolution: DeviceDisplayCapabilityResolution;
}

interface UnavailableDisplayProfileState {
  status: 'unavailable';
  reason: string;
  resettable: boolean;
}

type DisplayProfileState = ResolvedDisplayProfileState | UnavailableDisplayProfileState;

function superResolutionLabel(level: ServerSuperResolutionLevel) {
  return level === 'standard' ? '标准' : level === 'high' ? '高' : level === 'ultra' ? '极致' : level === 'ai' ? 'AI 清晰' : '关闭';
}

function generationStageLabel(stage?: TranscodeStatus['generationStage']) {
  return stage === 'extracting' ? '提取画面' : stage === 'enhancing' ? 'AI 重建' : stage === 'encoding' ? '输出兼容流' : '生成';
}

function enhancedPreparingStatus(level: ServerSuperResolutionLevel) {
  return level === 'ai'
    ? '电脑正在完整预处理 AI 清晰影片，完成后自动播放…'
    : `正在由电脑生成${superResolutionLabel(level)}超分流…`;
}

function enhancedReadyStatus(level: ServerSuperResolutionLevel) {
  return level === 'ai'
    ? '电脑端 AI 清晰 · 已完整缓存'
    : `电脑端${superResolutionLabel(level)}超分 · 可拖动`;
}

function dynamicRangeLabel(item: Pick<PublicMediaItem, 'dynamicRange' | 'bitDepth'>) {
  const range = item.dynamicRange === 'dolby-vision' ? '杜比视界'
    : item.dynamicRange === 'hdr10' ? 'HDR10'
      : item.dynamicRange === 'hlg' ? 'HLG'
        : item.dynamicRange === 'sdr10' ? '高位深 SDR'
          : item.dynamicRange === 'unknown' || item.dynamicRange === undefined ? '未知色彩范围'
            : 'SDR';
  return item.bitDepth ? `${range} · ${item.bitDepth}-bit` : range;
}

function compatibilityNoticeLabel(item: Pick<PublicMediaItem, 'dynamicRange' | 'compatibilityMode'>) {
  return item.dynamicRange === 'dolby-vision' ? '杜比视界兼容'
    : item.dynamicRange === 'unknown' || item.dynamicRange === undefined ? '色彩未知兼容'
      : item.dynamicRange === 'sdr10' ? '高位深兼容'
        : item.compatibilityMode === 'tone-map' ? 'HDR → SDR'
          : '电脑端兼容';
}

function displayProfileRelevant(item: PublicMediaItem) {
  return item.kind === 'video'
    && (item.dynamicRange !== 'sdr' || Boolean(item.bitDepth && item.bitDepth > 8));
}

function isGuidedDisplayRange(range: PublicMediaItem['dynamicRange']): range is VerifiedDisplayDynamicRange {
  return range === 'hdr10' || range === 'hlg' || range === 'sdr10';
}

function prepareDisplayProfile(
  item: PublicMediaItem,
  storage: DeviceDisplayStorage,
  browser: { origin: string; userAgent: string; platform: string },
): DisplayProfileState | undefined {
  if (!displayProfileRelevant(item)) return undefined;
  if (!isGuidedDisplayRange(item.dynamicRange)) {
    return {
      status: 'unavailable',
      resettable: false,
      reason: item.dynamicRange === 'dolby-vision'
        ? '杜比视界不能通过本地目视确认获得持久授权；默认使用未认证的 8-bit 兼容流。'
        : '源色彩范围未知或不受支持，不能保存设备显示确认。',
    };
  }

  const environment = buildDeviceDisplayEnvironment(browser);
  if (!environment.ok) return { status: 'unavailable', reason: environment.detail, resettable: false };
  const media = buildExactDisplayMediaInput(item);
  if (!media.ok) return { status: 'unavailable', reason: media.detail, resettable: false };
  const installation = getOrCreateDeviceDisplayInstallationId(storage);
  if (!installation.ok) {
    return {
      status: 'unavailable',
      reason: `设备显示档案不可用：${installation.detail}`,
      resettable: installation.reason === 'corrupt' || installation.reason === 'unknown-schema',
    };
  }
  return {
    status: 'resolved',
    installationId: installation.value,
    environment: environment.environment,
    media: media.media,
    browserName: environment.browserName,
    resolution: resolveDeviceDisplayCapabilityGrant(storage, {
      installationId: installation.value,
      environment: environment.environment,
      media: media.media,
    }),
  };
}

function displayProfileMessage(state: DisplayProfileState) {
  if (state.status === 'unavailable') return state.reason;
  if (state.resolution.granted) {
    const source = state.resolution.grant.evidenceSource === 'guided-user'
      ? '本设备人工确认（非仪器验证）'
      : state.resolution.grant.evidenceSource === 'instrumented' ? '仪器验证' : '厂商认证';
    return `${source}，有效至 ${new Date(state.resolution.grant.expiresAt).toLocaleDateString('zh-CN')}。`;
  }
  const messages: Partial<Record<typeof state.resolution.reason, string>> = {
    'no-profile': '这台设备尚未确认过这一精确原片。',
    expired: '本片的设备确认已过期，需要重新完成真机观察。',
    revoked: '本片的设备确认已撤销。',
    'browser-major-changed': '浏览器主版本已变化，需要重新完成真机观察。',
    'browser-engine-mismatch': '浏览器引擎已变化，旧确认不再适用。',
    'origin-mismatch': '当前 HTTPS 来源已变化，旧确认不再适用。',
    'platform-mismatch': '设备平台已变化，旧确认不再适用。',
    'pipeline-version-mismatch': '播放器呈现管线已变化，需要重新确认。',
    'media-mismatch': '片源或投影参数已变化，需要重新确认。',
    'storage-corrupt': '本地设备档案已损坏；请显式重置后再确认。',
    'unknown-schema': '本地设备档案版本无法识别；请显式重置。',
  };
  return messages[state.resolution.reason] || '当前设备档案未通过完整绑定校验，保持安全兼容流。';
}

function presentationAssurance(result?: BrowserMediaCapabilityResult): PlaybackPresentationAssurance {
  const source = result?.evidence.presentationGrant?.evidenceSource;
  return source === 'guided-user' ? 'guided-user'
    : source === 'instrumented' ? 'instrumented'
      : source === 'vendor-attested' ? 'vendor'
        : 'unverified';
}

export function MediaPlayer({ mediaId }: { mediaId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<XrVideoStage | undefined>(undefined);
  const hlsRef = useRef<Hls | undefined>(undefined);
  const progressSentAt = useRef(0);
  const resumePosition = useRef<number | undefined>(undefined);
  const resumePlaying = useRef(false);
  const resumeRetryTimer = useRef<number | undefined>(undefined);
  const seekCommitTimer = useRef<number | undefined>(undefined);
  const scrubTargetRef = useRef<number | undefined>(undefined);
  const xrOriginalSampleStartedAt = useRef<XrOriginalSamplePoint | undefined>(undefined);
  const transportRef = useRef<'direct' | 'hls'>('hls');
  const xrOptionsRef = useRef<XrVideoOptions>({ projection: 'flat', stereo: 'mono', eyeOrder: 'lr', yawOffset: 0 });
  const [data, setData] = useState<MediaResponse>();
  const [transport, setTransport] = useState<'direct' | 'hls'>('hls');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取媒体…');
  const [xrSupported, setXrSupported] = useState(false);
  const [enteringXr, setEnteringXr] = useState(false);
  const [xrSessionActive, setXrSessionActive] = useState(false);
  const [xrOriginalSampleReady, setXrOriginalSampleReady] = useState(false);
  const [diagnostics, setDiagnostics] = useState<XrDiagnostics>();
  const [clientCapability, setClientCapability] = useState<BrowserMediaCapabilityResult>();
  const [displayProfile, setDisplayProfile] = useState<DisplayProfileState>();
  const [directPlaybackFailed, setDirectPlaybackFailed] = useState(false);
  const [superResolution, setSuperResolution] = useState<ServerSuperResolutionLevel>(() => savedSuperResolution());
  const [serverEnhancement, setServerEnhancement] = useState<TranscodeStatus>();
  const [playback, setPlayback] = useState({ paused: true, currentTime: 0, duration: 0, muted: false });
  const [scrubTarget, setScrubTarget] = useState<number>();

  const selectTransport = useCallback((next: 'direct' | 'hls') => {
    transportRef.current = next;
    if (next !== 'direct') {
      xrOriginalSampleStartedAt.current = undefined;
      setXrOriginalSampleReady(false);
    }
    setTransport(next);
  }, []);

  const load = useCallback(async () => {
    try {
      setDirectPlaybackFailed(false);
      setXrOriginalSampleReady(false);
      const response = await getJson<MediaResponse>(`/api/media/${mediaId}`);
      let currentDisplayProfile: DisplayProfileState | undefined;
      try {
        const userAgentData = navigator as Navigator & { userAgentData?: { platform?: string } };
        currentDisplayProfile = prepareDisplayProfile(response.item, window.localStorage, {
          origin: window.location.origin,
          userAgent: navigator.userAgent,
          platform: userAgentData.userAgentData?.platform || navigator.platform,
        });
      } catch (cause) {
        currentDisplayProfile = displayProfileRelevant(response.item)
          ? {
              status: 'unavailable',
              resettable: false,
              reason: cause instanceof Error ? `设备显示档案不可用：${cause.message}` : '设备显示档案不可用。',
            }
          : undefined;
      }
      const presentationGrant = currentDisplayProfile?.status === 'resolved'
        && currentDisplayProfile.resolution.granted
        ? currentDisplayProfile.resolution.grant
        : undefined;
      const presentationGrantRequest = currentDisplayProfile?.status === 'resolved'
        ? {
            installationId: currentDisplayProfile.installationId,
            environment: currentDisplayProfile.environment,
            media: currentDisplayProfile.media,
          }
        : undefined;
      const probeElement = document.createElement(response.item.kind === 'audio' ? 'audio' : 'video');
      const mediaCapabilities = window.navigator.mediaCapabilities;
      const capability = await probeBrowserMediaCapability(response.item, {
        canPlayType: (contentType) => probeElement.canPlayType(contentType),
        decodingInfo: mediaCapabilities?.decodingInfo
          ? async (configuration: ClientMediaDecodingConfiguration) => {
              const result = await mediaCapabilities.decodingInfo(configuration as MediaDecodingConfiguration);
              return {
                supported: result.supported,
                smooth: result.smooth,
                powerEfficient: result.powerEfficient,
              };
            }
          : undefined,
        presentationGrant,
        presentationGrantRequest,
      });
      setData(response);
      setDisplayProfile(currentDisplayProfile);
      setClientCapability(capability);
      const level = savedSuperResolution();
      setSuperResolution(level);
      const enhanced = response.item.kind === 'video' && level !== 'off';
      const originalSupported = capability.decision.canAttemptOriginal;
      selectTransport(enhanced || !originalSupported ? 'hls' : 'direct');
      setStatus(enhanced
        ? enhancedPreparingStatus(level)
        : originalSupported
          ? response.item.directPlay ? '原片优先 · 浏览器安全直连' : '原片优先 · 当前设备确认可尝试'
          : '正在准备兼容流…');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '媒体不存在');
    }
  }, [mediaId, selectTransport]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const streamUrl = data?.item.streamUrl;
  const mediaItemId = data?.item.id;
  const mediaItemKind = data?.item.kind;
  const mediaProjection = data?.item.projection;
  const mediaStereo = data?.item.stereo;
  const hlsPlayback = mediaItemId ? hlsPlaybackUrls({
    mediaId: mediaItemId,
    superResolution: mediaItemKind === 'video' ? superResolution : 'off',
    requiresForcedVideoTranscode: clientCapability?.decision.requiresForcedVideoTranscode,
    directPlaybackFailed,
  }) : undefined;
  const hlsUrl = hlsPlayback?.manifestUrl;
  const hlsStatusUrl = hlsPlayback?.statusUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl || !hlsUrl) return;
    const controller = new AbortController();
    hlsRef.current?.destroy();
    hlsRef.current = undefined;
    setServerEnhancement(undefined);
    video.pause();
    if (resumeRetryTimer.current !== undefined) {
      window.clearTimeout(resumeRetryTimer.current);
      resumeRetryTimer.current = undefined;
    }
    video.removeAttribute('src');
    video.load();

    if (transport === 'direct') {
      video.src = streamUrl;
    } else {
      const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
      const mediaSourceHls = Hls.isSupported();
      const hlsTransport = chooseHlsTransport({ nativeHls, mediaSourceHls, userAgent: window.navigator.userAgent });
      if (hlsTransport === 'unsupported') {
        const timer = window.setTimeout(() => setError('当前浏览器既不能直接播放该文件，也不支持 HLS MediaSource。'), 0);
        return () => window.clearTimeout(timer);
      }
      void (async () => {
        try {
          let ready = false;
          let lastProgressAt = Date.now();
          let lastProgress = '';
          while (!controller.signal.aborted) {
            const response = await fetch(hlsUrl, { credentials: 'include', cache: 'no-store', signal: controller.signal });
            if (response.ok && response.headers.get('content-type')?.includes('mpegurl')) {
              await response.body?.cancel();
              ready = true;
              break;
            }
            const body = await response.json().catch(() => ({})) as { stage?: string; state?: string; progressBytes?: number; totalBytes?: number; progressSeconds?: number; message?: string; error?: string };
            if (response.status !== 202 && response.status !== 503) throw new Error(body.message || body.error || `HLS 准备失败：HTTP ${response.status}`);
            const progressKey = body.stage === 'cloud-cache'
              ? `cloud:${body.progressBytes || 0}`
              : `transcode:${body.progressSeconds || 0}:${body.state || response.status}`;
            if (progressKey !== lastProgress) {
              lastProgress = progressKey;
              lastProgressAt = Date.now();
            }
            if (body.stage === 'cloud-cache') {
              const percent = body.totalBytes ? Math.min(99, Math.round((body.progressBytes || 0) / body.totalBytes * 100)) : undefined;
              setStatus(`正在从云盘缓存到电脑${percent === undefined ? '…' : ` ${percent}%`}`);
            } else if (superResolution !== 'off') setStatus(enhancedPreparingStatus(superResolution));
            const idleLimit = body.stage === 'cloud-cache' ? 120_000 : 300_000;
            if (Date.now() - lastProgressAt > idleLimit) {
              throw new Error(body.stage === 'cloud-cache' ? '云盘缓存已连续两分钟没有进展，请检查云盘连接。' : '电脑端转码已连续五分钟没有进展，请检查 FFmpeg 与磁盘空间。');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
          if (!ready || controller.signal.aborted) {
            return;
          }
          const transcodeStatus = await getJson<TranscodeStatus>(hlsStatusUrl!);
          if (!controller.signal.aborted) setServerEnhancement(transcodeStatus);
          if (hlsTransport === 'native') {
            video.src = hlsUrl;
            setStatus(superResolution === 'off' ? 'Safari 原生 HLS 兼容流' : enhancedReadyStatus(superResolution));
          } else {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
              backBufferLength: 60,
              maxBufferLength: 12,
              maxMaxBufferLength: 30,
              startFragPrefetch: true,
              fragLoadingTimeOut: 120_000,
              fragLoadingMaxRetry: 2,
              xhrSetup: (xhr) => { xhr.withCredentials = true; },
            });
            hlsRef.current = hls;
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus(superResolution === 'off' ? 'HLS 兼容流已就绪' : enhancedReadyStatus(superResolution)));
            hls.on(Hls.Events.ERROR, (_event, info) => {
              if (info.fatal) setError(`HLS 播放失败：${info.details}`);
            });
          }
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'HLS 准备失败');
        }
      })();
    }
    return () => {
      controller.abort();
      if (resumeRetryTimer.current !== undefined) {
        window.clearTimeout(resumeRetryTimer.current);
        resumeRetryTimer.current = undefined;
      }
      hlsRef.current?.destroy();
      hlsRef.current = undefined;
    };
  }, [hlsStatusUrl, hlsUrl, mediaItemId, mediaItemKind, mediaProjection, mediaStereo, streamUrl, superResolution, transport]);

  useEffect(() => {
    if (!hlsStatusUrl || mediaItemKind !== 'video' || transport !== 'hls') return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          hlsStatusUrl,
          { credentials: 'include', cache: 'no-store', signal: controller.signal },
        );
        if (response.ok) {
          const next = await response.json() as TranscodeStatus;
          if (!controller.signal.aborted) setServerEnhancement(next);
        }
      } catch {
        // The manifest request reports actionable errors. Status polling is
        // intentionally quiet so a brief Wi-Fi pause does not cover playback.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, superResolution === 'off' ? 2_000 : 750);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hlsStatusUrl, mediaItemKind, superResolution, transport]);

  useEffect(() => () => {
    if (seekCommitTimer.current !== undefined) window.clearTimeout(seekCommitTimer.current);
  }, []);

  const xrItem = data?.item;
  const xrMediaId = xrItem?.id;
  const xrMediaKind = xrItem?.kind;
  const xrProjection = xrItem?.projection;
  const xrStereo = xrItem?.stereo;
  const xrEyeOrder = xrItem?.eyeOrder;
  const xrYawOffset = xrItem?.yawOffset;
  useEffect(() => {
    if (!xrProjection || !xrStereo || !xrEyeOrder || xrYawOffset === undefined) return;
    const options: XrVideoOptions = { projection: xrProjection, stereo: xrStereo, eyeOrder: xrEyeOrder, yawOffset: xrYawOffset };
    xrOptionsRef.current = options;
    stageRef.current?.update(options);
  }, [xrProjection, xrStereo, xrEyeOrder, xrYawOffset]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !xrMediaId || xrMediaKind !== 'video') return;
    let active = true;
    setXrSessionActive(false);
    const stage = new XrVideoStage(video, xrOptionsRef.current, (sessionActive) => {
      if (!active) return;
      setXrSessionActive(sessionActive);
      if (sessionActive) {
        const quality = video.getVideoPlaybackQuality?.();
        xrOriginalSampleStartedAt.current = transportRef.current === 'direct'
          ? { wallTime: Date.now(), mediaTime: video.currentTime, totalFrames: quality?.totalVideoFrames }
          : undefined;
      } else {
        const sample = xrOriginalSampleStartedAt.current;
        xrOriginalSampleStartedAt.current = undefined;
        const quality = video.getVideoPlaybackQuality?.();
        if (qualifiesXrOriginalSample(sample, {
          wallTime: Date.now(),
          mediaTime: video.currentTime,
          totalFrames: quality?.totalVideoFrames,
        }, transportRef.current === 'direct')) {
          setXrOriginalSampleReady(true);
        }
      }
      setDiagnostics(stage.diagnostics());
    });
    stageRef.current = stage;
    void stage.isSupported().then((supported) => { if (active) setXrSupported(supported); }).catch(() => { if (active) setXrSupported(false); });
    const updateDiagnostics = () => setDiagnostics(stage.diagnostics());
    video.addEventListener('loadedmetadata', updateDiagnostics);
    return () => {
      active = false;
      xrOriginalSampleStartedAt.current = undefined;
      video.removeEventListener('loadedmetadata', updateDiagnostics);
      stage.dispose();
      stageRef.current = undefined;
    };
  }, [xrMediaId, xrMediaKind]);

  const rememberPlaybackForSourceSwitch = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.currentTime)) return;
    resumePosition.current = video.currentTime;
    resumePlaying.current = !video.paused;
  };

  const updateMedia = async (patch: Partial<Pick<PublicMediaItem, 'projection' | 'stereo' | 'eyeOrder' | 'yawOffset'>>) => {
    if (!data) return;
    if (patch.projection !== undefined || patch.stereo !== undefined) rememberPlaybackForSourceSwitch();
    try {
      const response = await getJson<{ item: PublicMediaItem }>(`/api/media/${mediaId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setData((current) => current ? { ...current, item: response.item } : current);
      setError('');
      if (patch.projection !== undefined || patch.stereo !== undefined) {
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法更新播放设置');
    }
  };

  const saveProgress = (force = false) => {
    const video = videoRef.current;
    if (!video || !data) return;
    const now = Date.now();
    if (!force && now - progressSentAt.current < 8_000) return;
    progressSentAt.current = now;
    void fetch(`/api/progress/${mediaId}`, {
      method: 'PUT', credentials: 'include', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: video.currentTime, duration: video.duration || data.item.duration }),
    });
  };

  const onLoadedMetadata = () => {
    const video = videoRef.current;
    const switchedPosition = resumePosition.current;
    const saved = switchedPosition ?? data?.progress?.position;
    setStatus(transport === 'direct' ? '原始文件直连' : superResolution === 'off' ? '兼容流已就绪' : enhancedReadyStatus(superResolution));
    if (video) setPlayback({
      paused: video.paused,
      currentTime: video.currentTime,
      duration: Math.max(Number.isFinite(video.duration) ? video.duration : 0, data?.item.duration ?? 0),
      muted: video.muted,
    });
    const attemptResume = () => {
      if (!video || !saved || saved <= 0) {
        resumePosition.current = undefined;
        resumePlaying.current = false;
        return;
      }
      let seekable = transport === 'direct' || (transport === 'hls' && superResolution !== 'off');
      for (let index = 0; index < video.seekable.length; index += 1) {
        if (saved >= video.seekable.start(index) - 0.25 && saved <= video.seekable.end(index) + 0.25) {
          seekable = true;
          break;
        }
      }
      if (!seekable) {
        setStatus(`电脑端正在生成到续播位置 ${clock(saved)}…`);
        resumeRetryTimer.current = window.setTimeout(attemptResume, 1_000);
        return;
      }
      video.currentTime = Math.min(saved, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : saved);
      if (switchedPosition !== undefined && resumePlaying.current) void video.play().catch(() => undefined);
      resumePosition.current = undefined;
      resumePlaying.current = false;
      resumeRetryTimer.current = undefined;
    };
    attemptResume();
    if (stageRef.current) setDiagnostics(stageRef.current.diagnostics());
  };

  const syncPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    setPlayback({
      paused: video.paused,
      currentTime: video.currentTime,
      duration: Math.max(Number.isFinite(video.duration) ? video.duration : 0, data?.item.duration ?? 0),
      muted: video.muted,
    });
  };

  const commitSeek = (target = scrubTargetRef.current) => {
    const video = videoRef.current;
    if (!video || target === undefined || !Number.isFinite(target)) return;
    if (seekCommitTimer.current !== undefined) window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = undefined;
    const duration = Math.max(playback.duration, data?.item.duration ?? 0);
    const next = Math.max(0, Math.min(target, Math.max(0, duration - 0.05)));
    video.currentTime = next;
    setPlayback((current) => ({ ...current, currentTime: next }));
    if (superResolution !== 'off') setStatus(`正在优先生成 ${clock(next)} 的电脑端超分分片…`);
  };

  const previewSeek = (target: number) => {
    scrubTargetRef.current = target;
    setScrubTarget(target);
    if (seekCommitTimer.current !== undefined) window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = window.setTimeout(() => commitSeek(target), 180);
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch((cause) => setError(cause instanceof Error ? cause.message : '无法开始播放'));
    else video.pause();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    syncPlayback();
  };

  const enterFullscreen = async () => {
    const video = videoRef.current;
    const stage = video?.closest('.video-stage') as HTMLElement | null;
    try {
      if (stage?.requestFullscreen) await stage.requestFullscreen();
      else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法进入全屏');
    }
  };

  const changeSuperResolution = (level: ServerSuperResolutionLevel) => {
    rememberPlaybackForSourceSwitch();
    setDirectPlaybackFailed(false);
    window.localStorage.setItem('localis.serverSuperResolution', level);
    setError('');
    setSuperResolution(level);
    const originalSupported = clientCapability?.decision.canAttemptOriginal ?? data?.item.directPlay;
    selectTransport(level === 'off' && originalSupported ? 'direct' : 'hls');
    setStatus(level === 'off' ? '正在切换原始画质…' : enhancedPreparingStatus(level));
  };

  const onMediaError = () => {
    const video = videoRef.current;
    if (transport === 'direct' && !directPlaybackFailed) {
      setDirectPlaybackFailed(true);
      selectTransport('hls');
      setError('');
      setStatus('浏览器无法解码原文件，已切换兼容流…');
      return;
    }
    setError(video?.error ? `媒体错误 ${video.error.code}：${video.error.message}` : '播放失败');
  };

  const confirmDisplayProfile = async () => {
    if (displayProfile?.status !== 'resolved' || !xrOriginalSampleReady) return;
    const created = createGuidedUserDeviceDisplayProfile({
      installationId: displayProfile.installationId,
      environment: displayProfile.environment,
      media: displayProfile.media,
    });
    if (!created.ok) {
      setError(`无法保存设备确认：${created.detail}`);
      return;
    }
    const written = upsertDeviceDisplayCapabilityProfile(window.localStorage, created.profile);
    if (!written.ok) {
      setError(`无法保存设备确认：${written.detail}`);
      return;
    }
    rememberPlaybackForSourceSwitch();
    setStatus('已保存本片的设备人工确认，正在重新验证播放路径…');
    await load();
  };

  const revokeDisplayProfile = async () => {
    if (displayProfile?.status !== 'resolved' || !displayProfile.resolution.granted) return;
    const revoked = revokeDeviceDisplayCapabilityProfile(
      window.localStorage,
      displayProfile.resolution.grant.profileId,
    );
    if (!revoked.ok) {
      setError(`无法撤销设备确认：${revoked.detail}`);
      return;
    }
    rememberPlaybackForSourceSwitch();
    setStatus('已撤销本片设备确认，正在切换安全兼容流…');
    await load();
  };

  const resetDisplayProfiles = async () => {
    const reset = resetDeviceDisplayCapabilityStore(window.localStorage);
    if (!reset.ok) {
      setError(`无法重置设备档案：${reset.detail}`);
      return;
    }
    rememberPlaybackForSourceSwitch();
    setStatus('设备显示档案已重置，正在恢复安全兼容策略…');
    await load();
  };

  const enterXr = async () => {
    setError('');
    setEnteringXr(true);
    try {
      await stageRef.current?.enter();
      if (stageRef.current) setDiagnostics(stageRef.current.diagnostics());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法进入 WebXR');
    } finally {
      setEnteringXr(false);
    }
  };

  const exportDiagnostics = () => {
    const video = videoRef.current;
    const report = {
      generatedAt: new Date().toISOString(),
      location: window.location.origin,
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent,
      xrSupported,
      xrSessionActive,
      xrOriginalSampleReady,
      displayProfile,
      transport,
      clientCapability,
      forcedServerCompatibility: hlsPlayback?.forceCompatibility,
      serverSuperResolution: superResolution,
      item: data?.item,
      transcode: serverEnhancement ?? data?.transcode,
      video: video ? {
        currentSrc: video.currentSrc,
        readyState: video.readyState,
        networkState: video.networkState,
        currentTime: video.currentTime,
        duration: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        error: video.error ? { code: video.error.code, message: video.error.message } : undefined,
      } : undefined,
      xr: diagnostics,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `localis-diagnostics-${mediaId}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (error && !data) return <main className="player-error"><h1>无法打开媒体</h1><p>{error}</p><a href="/">返回媒体库</a></main>;
  if (!data) return <main className="player-loading"><span className="brand-mark large"><i /></span><p>{status}</p></main>;
  const { item } = data;
  const playbackDuration = Math.max(playback.duration, item.duration || 0);
  const displayedTime = scrubTarget ?? playback.currentTime;
  const playbackPercent = playbackDuration > 0 ? Math.min(100, Math.max(0, displayedTime / playbackDuration * 100)) : 0;
  const enhancementPercent = Math.min(100, Math.max(0, serverEnhancement?.progressPercent ?? 0));
  const activeEnhancementPercent = Math.min(100, Math.max(0, serverEnhancement?.activeSegmentPercent ?? 0));
  const displayedEnhancementPercent = serverEnhancement?.strategy === 'precompute'
    ? enhancementPercent
    : serverEnhancement?.generationState === 'processing'
    ? activeEnhancementPercent
    : enhancementPercent;
  const enhancementPercentLabel = enhancementPercent > 0 && enhancementPercent < 1
    ? '<1%'
    : `${enhancementPercent < 10 ? enhancementPercent.toFixed(1) : enhancementPercent.toFixed(0)}%`;
  const playbackTrackStyle = { '--range-progress': `${playbackPercent}%` } as CSSProperties;
  const enhancementTrackStyle = { '--generation-progress': `${displayedEnhancementPercent}%` } as CSSProperties;
  const enhancementSpeed = serverEnhancement?.speed && serverEnhancement.speed > 0.01
    ? `${serverEnhancement.speed.toFixed(1)}×`
    : undefined;
  const enhancementEta = serverEnhancement?.activeEtaSeconds && serverEnhancement.activeEtaSeconds > 1
    ? `约 ${clock(serverEnhancement.activeEtaSeconds)}`
    : undefined;
  const precomputeEta = serverEnhancement?.etaSeconds && serverEnhancement.etaSeconds > 1
    ? `约 ${clock(serverEnhancement.etaSeconds)}`
    : undefined;
  const playbackServerStatus = hlsPlayback?.forceCompatibility
    ? { ...(serverEnhancement || {}), mode: 'transcode', forcedCompatibility: true }
    : serverEnhancement;
  const playbackPath = describePlaybackPath({
    compatibility: {
      directPlay: item.directPlay,
      compatibilityMode: item.compatibilityMode,
      compatibilityReason: item.compatibilityReason,
      dynamicRange: item.dynamicRange,
      bitDepth: item.bitDepth,
      colorTransfer: item.colorTransfer,
      audioCodec: item.audioCodec,
    },
    transport,
    superResolution,
    serverEnhancement: playbackServerStatus,
    presentationAssurance: presentationAssurance(clientCapability),
  });

  return (
    <main className="player-page">
      <header className="player-header">
        <a href="/" className="back-link"><span className="back-icon" aria-hidden="true" />媒体库</a>
        <div><h1>{item.title}</h1><p>{item.fileName}</p></div>
        <span className="transport-status"><i />{status}</span>
      </header>

      <section className={`video-stage ${item.kind === 'audio' ? 'audio-stage' : ''}`}>
        {item.kind === 'audio' && <div className="audio-visual"><i /><i /><i /><i /><i /><i /><i /></div>}
        <video
          ref={videoRef}
          controls={item.kind === 'audio'}
          playsInline
          preload="auto"
          poster={item.posterUrl}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={() => { saveProgress(false); if (scrubTargetRef.current === undefined) syncPlayback(); }}
          onPlay={syncPlayback}
          onPlaying={() => {
            syncPlayback();
            if (superResolution !== 'off') setStatus(enhancedReadyStatus(superResolution));
            if (xrSessionActive && transport === 'direct' && !xrOriginalSampleStartedAt.current) {
              const quality = videoRef.current?.getVideoPlaybackQuality?.();
              xrOriginalSampleStartedAt.current = {
                wallTime: Date.now(),
                mediaTime: videoRef.current?.currentTime ?? 0,
                totalFrames: quality?.totalVideoFrames,
              };
            }
          }}
          onPause={() => {
            if (xrSessionActive) xrOriginalSampleStartedAt.current = undefined;
            saveProgress(true);
            syncPlayback();
          }}
          onSeeking={() => {
            if (xrSessionActive) xrOriginalSampleStartedAt.current = undefined;
          }}
          onVolumeChange={syncPlayback}
          onDurationChange={syncPlayback}
          onSeeked={() => { scrubTargetRef.current = undefined; setScrubTarget(undefined); syncPlayback(); if (superResolution !== 'off') setStatus(enhancedReadyStatus(superResolution)); }}
          onEnded={() => { saveProgress(true); syncPlayback(); }}
          onError={onMediaError}
        >
          {item.subtitleTracks.map((track, index) => (
            <track key={track.index} kind="subtitles" src={`/api/media/${item.id}/subtitles/${track.index}.vtt`} srcLang={track.language || 'und'} label={track.title || track.language || `字幕 ${index + 1}`} default={index === 0} />
          ))}
        </video>
        {item.kind === 'video' && (
          <div className="localis-player-controls" role="group" aria-label="Localis 播放器控制">
            {superResolution !== 'off' && (
              <div className={`enhancement-progress ${serverEnhancement?.generationState === 'processing' ? 'processing' : ''}`}>
                <div className="enhancement-progress-copy">
                  <span><i />电脑端{superResolutionLabel(superResolution)}超分</span>
                  <strong>
                    {serverEnhancement?.generationState === 'complete'
                      ? '缓存完成'
                      : serverEnhancement?.generationState === 'processing'
                        ? serverEnhancement.strategy === 'precompute'
                          ? `整片预处理 ${enhancementPercentLabel}${enhancementSpeed ? ` · ${enhancementSpeed}` : ''}${precomputeEta ? ` · ${precomputeEta}` : ''}`
                          : `${generationStageLabel(serverEnhancement.generationStage)} ${clock(serverEnhancement.activeSegmentStartSeconds ?? displayedTime)} · ${activeEnhancementPercent.toFixed(0)}%${enhancementSpeed ? ` · ${enhancementSpeed}` : ''}${enhancementEta ? ` · ${enhancementEta}` : ''}`
                        : `已缓存 ${serverEnhancement?.generatedSegments ?? 0} 段 · ${enhancementPercentLabel}${enhancementSpeed ? ` · ${enhancementSpeed}` : ''}`}
                  </strong>
                </div>
                <div className="enhancement-track" style={enhancementTrackStyle} role="progressbar" aria-label="电脑端超分生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(displayedEnhancementPercent)}><i /></div>
                <small>{serverEnhancement?.strategy === 'precompute'
                  ? 'AI 会先在电脑上处理并缓存整部影片；达到 100% 前不会向头显开放播放，完成后可流畅拖动。'
                  : serverEnhancement?.strategy === 'on-demand'
                    ? `整部影片可直接拖动；电脑会优先生成你跳到的位置。总缓存 ${enhancementPercentLabel}。`
                    : '电脑正在准备完整兼容流。'}</small>
              </div>
            )}
            <div className="playback-control-row">
              <button className="playback-toggle" type="button" aria-label={playback.paused ? '播放' : '暂停'} onClick={togglePlayback}><span className={playback.paused ? 'play-icon' : 'pause-icon'} aria-hidden="true" /></button>
              <span className="playback-time">{clock(displayedTime)}</span>
              <input
                className="playback-seek"
                aria-label="播放进度"
                type="range"
                min="0"
                max={Math.max(playbackDuration, 0.01)}
                step="0.1"
                value={Math.min(displayedTime, playbackDuration || 0)}
                style={playbackTrackStyle}
                onInput={(event) => previewSeek(Number(event.currentTarget.value))}
                onChange={(event) => previewSeek(Number(event.currentTarget.value))}
                onPointerUp={() => commitSeek()}
                onKeyUp={() => commitSeek()}
                onBlur={() => commitSeek()}
              />
              <span className="playback-time">{clock(playbackDuration)}</span>
              <button className="player-text-button" type="button" aria-label={playback.muted ? '取消静音' : '静音'} onClick={toggleMute}>{playback.muted ? '开启声音' : '静音'}</button>
              <button className="player-text-button" type="button" aria-label="全屏" onClick={() => void enterFullscreen()}>全屏</button>
            </div>
          </div>
        )}
      </section>

      {error && <div className="inline-error player-inline-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}

      {item.kind === 'video' && (
        <section className={`playback-path playback-path-${playbackPath.kind} playback-path-${playbackPath.state}`} aria-label="当前影像链路">
          <div><span>当前影像链路</span><strong>{playbackPath.label}</strong><em>{playbackPath.stateLabel}</em></div>
          <p>{playbackPath.description}</p>
          {clientCapability && <small>设备判断：{clientCapability.decision.reason}</small>}
          {playbackPath.presentationAssuranceLabel && <small>呈现证据：{playbackPath.presentationAssuranceLabel}{playbackPath.presentationVerified ? ' · 已验证呈现' : ' · 不宣称已验证 HDR/10-bit'}</small>}
        </section>
      )}

      {item.kind === 'video' && displayProfile && (
        <section className={`display-profile ${displayProfile.status === 'resolved' && displayProfile.resolution.granted ? 'display-profile-granted' : ''}`} aria-label="设备原片显示确认">
          <div>
            <span>设备原片显示确认</span>
            <strong>{displayProfile.status === 'resolved' && displayProfile.resolution.granted ? '本片已有档案' : '安全兼容优先'}</strong>
          </div>
          <p>{displayProfileMessage(displayProfile)}</p>
          {displayProfile.status === 'resolved' && <small>
            绑定 {displayProfile.browserName} {displayProfile.environment.browserMajor} · {displayProfile.environment.origin} · 当前完整媒体元数据指纹 · 最长 90 天。人工确认只代表观感可接受，不等同仪器验证 HDR。
          </small>}
          {displayProfile.status === 'resolved' && !displayProfile.resolution.granted && (
            <div className="display-profile-guide">
              <small>{xrOriginalSampleReady
                ? '已完成连续原片 WebXR 观看。请仅在高光、暗部、色彩、渐变与双眼画面均可接受时保存。'
                : xrSessionActive && transport === 'direct'
                  ? '正在采样原片 WebXR 播放；请勿暂停或跳转，连续观看至少 10 秒后退出。'
                  : transport !== 'direct'
                    ? '先关闭电脑端增强并选择“尝试原始 HDR/10-bit”，再进入沉浸模式连续观看至少 10 秒。'
                    : '进入沉浸模式连续播放至少 10 秒并退出后，才会开放本片确认。'}</small>
              {xrOriginalSampleReady && <button className="mode-button display-profile-confirm" type="button" onClick={() => void confirmDisplayProfile()}>确认刚才观感并记住本片</button>}
            </div>
          )}
          {displayProfile.status === 'resolved' && displayProfile.resolution.granted && (
            <button className="mode-button" type="button" onClick={() => void revokeDisplayProfile()}>撤销本片确认</button>
          )}
          {(displayProfile.status === 'unavailable' && displayProfile.resettable)
            || (displayProfile.status === 'resolved' && !displayProfile.resolution.granted
              && (displayProfile.resolution.reason === 'storage-corrupt' || displayProfile.resolution.reason === 'unknown-schema'))
            ? <button className="mode-button" type="button" onClick={() => void resetDisplayProfiles()}>重置设备档案</button>
            : null}
        </section>
      )}

      {item.kind === 'video' && !item.directPlay && (
        <section className={`compatibility-notice ${item.dynamicRange !== 'sdr' ? 'hdr-notice' : ''}`} aria-label="媒体兼容性说明">
          <div><span>{compatibilityNoticeLabel(item)}</span><strong>{dynamicRangeLabel(item)}</strong></div>
          <p>{transport === 'direct' && clientCapability?.decision.canAttemptOriginal
            ? `${clientCapability.decision.reason} 若原片加载失败，Localis 会自动切换到电脑端兼容流。`
            : item.compatibilityReason}</p>
          <small>{item.compatibilityMode === 'tone-map'
            ? item.dynamicRange === 'dolby-vision'
              ? 'Localis 不执行 Dolby Vision 动态元数据重建；仅在基底传递函数明确时尝试映射，否则兼容流也不保证亮度与色彩正确。'
              : '“兼容流”输出标准 SDR；“尝试原始 HDR”不会改动文件，但是否呈现 HDR 由当前头显浏览器决定。'
            : item.dynamicRange === 'sdr10'
              ? '兼容流使用抖动把 10/12-bit SDR 降为 8-bit SDR；可减轻色带，但位深损失不可逆。'
              : item.dynamicRange === 'unknown'
                ? '源色彩元数据不完整；兼容流只输出 8-bit H.264 色彩未知画面，不保证亮度、动态范围或色彩正确。'
                : '原文件不会被修改，转换结果只保存在电脑端私有缓存。'}</small>
        </section>
      )}

      <section className="player-controls-panel">
        <div className="projection-controls">
          <label>投影<select value={item.projection} onChange={(event) => void updateMedia({ projection: event.target.value as PublicMediaItem['projection'] })}><option value="flat">平面</option><option value="equirect180">VR180</option><option value="equirect360">VR360</option></select></label>
          <label>立体布局<select value={item.stereo} onChange={(event) => void updateMedia({ stereo: event.target.value as PublicMediaItem['stereo'] })}><option value="mono">单目</option><option value="sbs">左右 SBS</option><option value="tb">上下 TB</option></select></label>
          <label>左右眼<select value={item.eyeOrder} disabled={item.stereo === 'mono'} onChange={(event) => void updateMedia({ eyeOrder: event.target.value as PublicMediaItem['eyeOrder'] })}><option value="lr">左 / 右</option><option value="rl">右 / 左</option></select></label>
          <label>电脑端超分<select aria-label="电脑端超分" value={superResolution} disabled={item.kind !== 'video'} onChange={(event) => changeSuperResolution(event.target.value as ServerSuperResolutionLevel)}><option value="off">关闭（可直连时为原片）</option><option value="standard">标准 · 最多 1.25×</option><option value="high">高 · 最多 1.5×</option><option value="ultra">极致 · 最多 2×</option><option value="ai">AI 清晰 · 完整预处理后播放</option></select></label>
          <label className="yaw-control">朝向<input aria-label="水平朝向" type="range" min="-3.15" max="3.15" step="0.05" value={item.yawOffset} onChange={(event) => void updateMedia({ yawOffset: Number(event.target.value) })} /></label>
          <button className="mode-button" onClick={() => void updateMedia({ yawOffset: 0 })}>重新居中</button>
          <button className="mode-button" disabled={superResolution !== 'off'} onClick={() => { setDirectPlaybackFailed(false); selectTransport(transport === 'direct' ? 'hls' : 'direct'); }}>{superResolution !== 'off' ? '超分由电脑流式输出' : transport === 'direct' ? '使用兼容流' : displayProfileRelevant(item) ? '尝试原始 HDR/10-bit' : '尝试原文件'}</button>
          <button className="mode-button" onClick={exportDiagnostics}>导出诊断</button>
        </div>
        <button className="xr-button" disabled={!xrSupported || enteringXr || item.kind !== 'video'} onClick={() => void enterXr()}>{enteringXr ? '正在进入…' : xrSupported ? '进入沉浸模式' : '此环境不可用 WebXR'}</button>
      </section>

      {item.kind === 'video' && <p className="super-resolution-note">关闭电脑端增强时，浏览器明确支持的 SDR 原片优先直连；无法安全直连的素材以及所有增强档使用电脑端 H.264 HLS，并保留自动失败回退。AI 清晰使用随项目携带的 Real-ESRGAN/NCNN Vulkan 通用视频模型，先完整生成并缓存整部影片，达到 100% 后才开放播放；SBS/TB 与 VR360 暂使用其他档位，以避免眼间串色和环绕接缝。</p>}

      <section className="media-details">
        <div><span>时长</span><strong>{clock(item.duration)}</strong></div>
        <div><span>源画面</span><strong>{item.width ? `${item.width}×${item.height} · ${item.frameRate || '—'} fps` : item.kind === 'audio' ? '仅音频' : '播放后检测'}</strong></div>
        <div><span>编码</span><strong>{[item.videoCodec, item.audioCodec].filter(Boolean).join(' / ') || '云端文件待检测'}</strong></div>
        <div><span>色彩</span><strong>{item.kind === 'video' ? dynamicRangeLabel(item) : '—'}</strong></div>
        <div><span>XR 安全环境</span><strong>{diagnostics?.secureContext ? '是' : '否'}</strong></div>
        <div><span>设备端超分</span><strong>已禁用</strong></div>
        <div><span>丢帧</span><strong>{diagnostics?.droppedFrames ?? '播放后检测'}{diagnostics?.totalFrames ? ` / ${diagnostics.totalFrames}` : ''}</strong></div>
        <div><span>电脑端超分</span><strong>{superResolution === 'off' ? '关闭' : serverEnhancement?.plan.outputWidth ? `${serverEnhancement.plan.sourceWidth}×${serverEnhancement.plan.sourceHeight} → ${serverEnhancement.plan.outputWidth}×${serverEnhancement.plan.outputHeight} · ${serverEnhancement.enhancementBackend || serverEnhancement.encoder}` : `${superResolutionLabel(superResolution)} · 准备中`}</strong></div>
      </section>
    </main>
  );
}
