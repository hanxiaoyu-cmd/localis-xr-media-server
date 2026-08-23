'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext currently duplicates React context when next/link is optimized in development. */

import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackProgress, PublicMediaItem } from '@/server/types';
import type { ServerSuperResolutionLevel, ServerSuperResolutionPlan } from '@/server/super-resolution';
import { XrVideoStage, type XrDiagnostics, type XrVideoOptions } from '@/app/lib/xr-video-stage';
import { chooseHlsTransport } from '@/app/lib/hls-transport';

interface TranscodeStatus {
  state: string;
  mode: string;
  encoder: string;
  progressSeconds: number;
  error?: string;
  superResolution: ServerSuperResolutionLevel;
  plan: ServerSuperResolutionPlan;
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
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

const serverSuperResolutionLevels = new Set<ServerSuperResolutionLevel>(['off', 'standard', 'high', 'ultra']);

function savedSuperResolution(): ServerSuperResolutionLevel {
  if (typeof window === 'undefined') return 'standard';
  const saved = window.localStorage.getItem('localis.serverSuperResolution');
  if (saved && serverSuperResolutionLevels.has(saved as ServerSuperResolutionLevel)) return saved as ServerSuperResolutionLevel;
  const legacy = window.localStorage.getItem('localis.superResolution');
  if (legacy === 'off') return 'off';
  if (legacy === 'quality') return 'high';
  return 'standard';
}

function superResolutionLabel(level: ServerSuperResolutionLevel) {
  return level === 'standard' ? '标准' : level === 'high' ? '高' : level === 'ultra' ? '极致' : '关闭';
}

export function MediaPlayer({ mediaId }: { mediaId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<XrVideoStage | undefined>(undefined);
  const hlsRef = useRef<Hls | undefined>(undefined);
  const progressSentAt = useRef(0);
  const directFailed = useRef(false);
  const resumePosition = useRef<number | undefined>(undefined);
  const resumePlaying = useRef(false);
  const resumeRetryTimer = useRef<number | undefined>(undefined);
  const xrOptionsRef = useRef<XrVideoOptions>({ projection: 'flat', stereo: 'mono', eyeOrder: 'lr', yawOffset: 0 });
  const [data, setData] = useState<MediaResponse>();
  const [transport, setTransport] = useState<'direct' | 'hls'>('hls');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取媒体…');
  const [xrSupported, setXrSupported] = useState(false);
  const [enteringXr, setEnteringXr] = useState(false);
  const [diagnostics, setDiagnostics] = useState<XrDiagnostics>();
  const [superResolution, setSuperResolution] = useState<ServerSuperResolutionLevel>(() => savedSuperResolution());
  const [serverEnhancement, setServerEnhancement] = useState<TranscodeStatus>();

  const load = useCallback(async () => {
    try {
      directFailed.current = false;
      const response = await getJson<MediaResponse>(`/api/media/${mediaId}`);
      setData(response);
      const level = savedSuperResolution();
      setSuperResolution(level);
      const enhanced = response.item.kind === 'video' && level !== 'off';
      setTransport(enhanced || !response.item.directPlay ? 'hls' : 'direct');
      setStatus(enhanced ? `正在由电脑生成${superResolutionLabel(level)}超分流…` : response.item.directPlay ? '原始文件直连' : '正在准备兼容流…');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '媒体不存在');
    }
  }, [mediaId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const streamUrl = data?.item.streamUrl;
  const mediaItemId = data?.item.id;
  const mediaItemKind = data?.item.kind;
  const mediaProjection = data?.item.projection;
  const mediaStereo = data?.item.stereo;
  const hlsUrl = mediaItemId ? `/api/media/${mediaItemId}/hls/${mediaItemKind === 'video' ? superResolution : 'off'}/index.m3u8` : undefined;

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
            } else if (superResolution !== 'off') setStatus(`电脑正在生成${superResolutionLabel(superResolution)}超分流…`);
            const idleLimit = body.stage === 'cloud-cache' ? 120_000 : 300_000;
            if (Date.now() - lastProgressAt > idleLimit) {
              throw new Error(body.stage === 'cloud-cache' ? '云盘缓存已连续两分钟没有进展，请检查云盘连接。' : '电脑端转码已连续五分钟没有进展，请检查 FFmpeg 与磁盘空间。');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
          if (!ready || controller.signal.aborted) {
            return;
          }
          const transcodeStatus = await getJson<TranscodeStatus>(`/api/media/${mediaItemId}/hls/${mediaItemKind === 'video' ? superResolution : 'off'}/status`);
          if (!controller.signal.aborted) setServerEnhancement(transcodeStatus);
          if (hlsTransport === 'native') {
            video.src = hlsUrl;
            setStatus(superResolution === 'off' ? 'Safari 原生 HLS 兼容流' : `Safari 播放电脑端${superResolutionLabel(superResolution)}超分流`);
          } else {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
              backBufferLength: 60,
              xhrSetup: (xhr) => { xhr.withCredentials = true; },
            });
            hlsRef.current = hls;
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus(superResolution === 'off' ? 'HLS 兼容流已就绪' : `电脑端${superResolutionLabel(superResolution)}超分流已就绪`));
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
  }, [hlsUrl, mediaItemId, mediaItemKind, mediaProjection, mediaStereo, streamUrl, superResolution, transport]);

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
    const stage = new XrVideoStage(video, xrOptionsRef.current);
    stageRef.current = stage;
    void stage.isSupported().then((supported) => { if (active) setXrSupported(supported); }).catch(() => { if (active) setXrSupported(false); });
    const updateDiagnostics = () => setDiagnostics(stage.diagnostics());
    video.addEventListener('loadedmetadata', updateDiagnostics);
    return () => {
      active = false;
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
    setStatus(transport === 'direct' ? '原始文件直连' : superResolution === 'off' ? '兼容流已就绪' : `电脑端${superResolutionLabel(superResolution)}超分流已就绪`);
    const attemptResume = () => {
      if (!video || !saved || saved <= 0) {
        resumePosition.current = undefined;
        resumePlaying.current = false;
        return;
      }
      let seekable = transport === 'direct';
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

  const changeSuperResolution = (level: ServerSuperResolutionLevel) => {
    rememberPlaybackForSourceSwitch();
    window.localStorage.setItem('localis.serverSuperResolution', level);
    setError('');
    setSuperResolution(level);
    setTransport(level === 'off' && data?.item.directPlay ? 'direct' : 'hls');
    setStatus(level === 'off' ? '正在切换原始画质…' : `正在由电脑生成${superResolutionLabel(level)}超分流…`);
  };

  const onMediaError = () => {
    const video = videoRef.current;
    if (transport === 'direct' && !directFailed.current) {
      directFailed.current = true;
      setTransport('hls');
      setError('');
      setStatus('浏览器无法解码原文件，已切换兼容流…');
      return;
    }
    setError(video?.error ? `媒体错误 ${video.error.code}：${video.error.message}` : '播放失败');
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
      transport,
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

  return (
    <main className="player-page">
      <header className="player-header">
        <a href="/" className="back-link">← 媒体库</a>
        <div><h1>{item.title}</h1><p>{item.fileName}</p></div>
        <span className="transport-status"><i />{status}</span>
      </header>

      <section className={`video-stage ${item.kind === 'audio' ? 'audio-stage' : ''}`}>
        {item.kind === 'audio' && <div className="audio-visual"><i /><i /><i /><i /><i /><i /><i /></div>}
        <video
          ref={videoRef}
          controls
          playsInline
          preload="metadata"
          poster={item.posterUrl}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={() => saveProgress(false)}
          onPause={() => saveProgress(true)}
          onEnded={() => saveProgress(true)}
          onError={onMediaError}
        >
          {item.subtitleTracks.map((track, index) => (
            <track key={track.index} kind="subtitles" src={`/api/media/${item.id}/subtitles/${track.index}.vtt`} srcLang={track.language || 'und'} label={track.title || track.language || `字幕 ${index + 1}`} default={index === 0} />
          ))}
        </video>
      </section>

      {error && <div className="inline-error player-inline-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}

      <section className="player-controls-panel">
        <div className="projection-controls">
          <label>投影<select value={item.projection} onChange={(event) => void updateMedia({ projection: event.target.value as PublicMediaItem['projection'] })}><option value="flat">平面</option><option value="equirect180">VR180</option><option value="equirect360">VR360</option></select></label>
          <label>立体布局<select value={item.stereo} onChange={(event) => void updateMedia({ stereo: event.target.value as PublicMediaItem['stereo'] })}><option value="mono">单目</option><option value="sbs">左右 SBS</option><option value="tb">上下 TB</option></select></label>
          <label>左右眼<select value={item.eyeOrder} disabled={item.stereo === 'mono'} onChange={(event) => void updateMedia({ eyeOrder: event.target.value as PublicMediaItem['eyeOrder'] })}><option value="lr">左 / 右</option><option value="rl">右 / 左</option></select></label>
          <label>电脑端超分<select aria-label="电脑端超分" value={superResolution} disabled={item.kind !== 'video'} onChange={(event) => changeSuperResolution(event.target.value as ServerSuperResolutionLevel)}><option value="off">关闭（可直连时为原片）</option><option value="standard">标准 · 最多 1.25×</option><option value="high">高 · 最多 1.5×</option><option value="ultra">极致 · 最多 2×</option></select></label>
          <label className="yaw-control">朝向<input aria-label="水平朝向" type="range" min="-3.15" max="3.15" step="0.05" value={item.yawOffset} onChange={(event) => void updateMedia({ yawOffset: Number(event.target.value) })} /></label>
          <button className="mode-button" onClick={() => void updateMedia({ yawOffset: 0 })}>重新居中</button>
          <button className="mode-button" disabled={superResolution !== 'off'} onClick={() => { directFailed.current = transport === 'direct'; setTransport(transport === 'direct' ? 'hls' : 'direct'); }}>{superResolution !== 'off' ? '超分由电脑流式输出' : transport === 'direct' ? '使用兼容流' : '尝试原文件'}</button>
          <button className="mode-button" onClick={exportDiagnostics}>导出诊断</button>
        </div>
        <button className="xr-button" disabled={!xrSupported || enteringXr || item.kind !== 'video'} onClick={() => void enterXr()}>{enteringXr ? '正在进入…' : xrSupported ? '进入沉浸模式' : '此环境不可用 WebXR'}</button>
      </section>

      {item.kind === 'video' && <p className="super-resolution-note">超分与锐化完全由运行 Localis 的电脑完成；Vision Pro、Quest 和 PICO 只接收标准 H.264 HLS 并负责显示。档位倍率是上限：高分辨率原片不会被反向缩小，超过 H.264 Level 5.2 安全范围时会明确停用该档。</p>}

      <section className="media-details">
        <div><span>时长</span><strong>{clock(item.duration)}</strong></div>
        <div><span>源画面</span><strong>{item.width ? `${item.width}×${item.height} · ${item.frameRate || '—'} fps` : item.kind === 'audio' ? '仅音频' : '播放后检测'}</strong></div>
        <div><span>编码</span><strong>{[item.videoCodec, item.audioCodec].filter(Boolean).join(' / ') || '云端文件待检测'}</strong></div>
        <div><span>XR 安全环境</span><strong>{diagnostics?.secureContext ? '是' : '否'}</strong></div>
        <div><span>设备端超分</span><strong>已禁用</strong></div>
        <div><span>丢帧</span><strong>{diagnostics?.droppedFrames ?? '播放后检测'}{diagnostics?.totalFrames ? ` / ${diagnostics.totalFrames}` : ''}</strong></div>
        <div><span>电脑端超分</span><strong>{superResolution === 'off' ? '关闭' : serverEnhancement?.plan.outputWidth ? `${serverEnhancement.plan.sourceWidth}×${serverEnhancement.plan.sourceHeight} → ${serverEnhancement.plan.outputWidth}×${serverEnhancement.plan.outputHeight} · ${serverEnhancement.encoder}` : `${superResolutionLabel(superResolution)} · 准备中`}</strong></div>
      </section>
    </main>
  );
}
