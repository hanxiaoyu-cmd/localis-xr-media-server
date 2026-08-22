'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext currently duplicates React context when next/link is optimized in development. */

import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackProgress, PublicMediaItem } from '@/server/types';
import { XrVideoStage, type XrDiagnostics, type XrVideoOptions } from '@/app/lib/xr-video-stage';
import {
  InlineVideoSuperResolution,
  type SuperResolutionDiagnostics,
  type SuperResolutionMode,
} from '@/app/lib/video-super-resolution';

interface MediaResponse {
  item: PublicMediaItem;
  progress?: PlaybackProgress;
  transcode: { state: string; mode: string; encoder: string; progressSeconds: number; error?: string };
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

const superResolutionModes = new Set<SuperResolutionMode>(['off', 'auto', 'quality', 'sharp']);

function activeCaption(video: HTMLVideoElement) {
  const track = [...video.textTracks].find((candidate) => candidate.mode !== 'disabled');
  return track?.activeCues
    ? [...track.activeCues].map((cue) => (cue as VTTCue).text.replace(/<[^>]*>/g, '')).join('\n')
    : '';
}

export function MediaPlayer({ mediaId }: { mediaId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const enhancerCanvasRef = useRef<HTMLCanvasElement>(null);
  const inlineEnhancerRef = useRef<InlineVideoSuperResolution | undefined>(undefined);
  const stageRef = useRef<XrVideoStage | undefined>(undefined);
  const hlsRef = useRef<Hls | undefined>(undefined);
  const progressSentAt = useRef(0);
  const directFailed = useRef(false);
  const xrOptionsRef = useRef<XrVideoOptions>({ projection: 'flat', stereo: 'mono', eyeOrder: 'lr', yawOffset: 0, superResolution: 'auto' });
  const [data, setData] = useState<MediaResponse>();
  const [transport, setTransport] = useState<'direct' | 'hls'>('direct');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取媒体…');
  const [xrSupported, setXrSupported] = useState(false);
  const [enteringXr, setEnteringXr] = useState(false);
  const [diagnostics, setDiagnostics] = useState<XrDiagnostics>();
  const [superResolution, setSuperResolution] = useState<SuperResolutionMode>('auto');
  const [superResolutionDiagnostics, setSuperResolutionDiagnostics] = useState<SuperResolutionDiagnostics>();
  const [playback, setPlayback] = useState({ paused: true, currentTime: 0, duration: 0, muted: false });
  const [caption, setCaption] = useState('');

  useEffect(() => {
    const saved = window.localStorage.getItem('localis.superResolution');
    if (saved && superResolutionModes.has(saved as SuperResolutionMode)) setSuperResolution(saved as SuperResolutionMode);
  }, []);

  const load = useCallback(async () => {
    try {
      directFailed.current = false;
      const response = await getJson<MediaResponse>(`/api/media/${mediaId}`);
      setData(response);
      setTransport(response.item.directPlay ? 'direct' : 'hls');
      setStatus(response.item.directPlay ? '原始文件直连' : '正在准备兼容流…');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '媒体不存在');
    }
  }, [mediaId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const streamUrl = data?.item.streamUrl;
  const hlsUrl = data?.item.hlsUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl || !hlsUrl) return;
    const controller = new AbortController();
    hlsRef.current?.destroy();
    hlsRef.current = undefined;
    video.pause();
    video.removeAttribute('src');
    video.load();

    if (transport === 'direct') {
      video.src = streamUrl;
    } else {
      const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
      const mediaSourceHls = Hls.isSupported();
      if (!nativeHls && !mediaSourceHls) {
        const timer = window.setTimeout(() => setError('当前浏览器既不能直接播放该文件，也不支持 HLS MediaSource。'), 0);
        return () => window.clearTimeout(timer);
      }
      void (async () => {
        try {
          let ready = false;
          for (let attempt = 0; attempt < 120 && !controller.signal.aborted; attempt += 1) {
            const response = await fetch(hlsUrl, { credentials: 'include', cache: 'no-store', signal: controller.signal });
            if (response.ok && response.headers.get('content-type')?.includes('mpegurl')) {
              await response.body?.cancel();
              ready = true;
              break;
            }
            if (response.status !== 202 && response.status !== 503) throw new Error(`HLS 准备失败：HTTP ${response.status}`);
            await response.body?.cancel();
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
          if (!ready || controller.signal.aborted) {
            if (!controller.signal.aborted) throw new Error('兼容流在两分钟内未能生成首个分片。');
            return;
          }
          if (nativeHls) {
            video.src = hlsUrl;
            setStatus('Safari 原生 HLS 兼容流');
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
            hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus('HLS 兼容流已就绪'));
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
      hlsRef.current?.destroy();
      hlsRef.current = undefined;
    };
  }, [hlsUrl, streamUrl, transport]);

  const xrItem = data?.item;
  const xrMediaId = xrItem?.id;
  const xrMediaKind = xrItem?.kind;
  const xrProjection = xrItem?.projection;
  const xrStereo = xrItem?.stereo;
  const xrEyeOrder = xrItem?.eyeOrder;
  const xrYawOffset = xrItem?.yawOffset;
  useEffect(() => {
    if (!xrProjection || !xrStereo || !xrEyeOrder || xrYawOffset === undefined) return;
    const options: XrVideoOptions = {
      projection: xrProjection,
      stereo: xrStereo,
      eyeOrder: xrEyeOrder,
      yawOffset: xrYawOffset,
      superResolution,
    };
    xrOptionsRef.current = options;
    stageRef.current?.update(options);
  }, [xrProjection, xrStereo, xrEyeOrder, xrYawOffset, superResolution]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !xrMediaId || xrMediaKind !== 'video') return;
    let active = true;
    const stage = new XrVideoStage(video, xrOptionsRef.current, (active) => inlineEnhancerRef.current?.setActive(!active));
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

  useEffect(() => {
    const video = videoRef.current;
    const canvas = enhancerCanvasRef.current;
    if (!video || !canvas || !xrMediaId || xrMediaKind !== 'video' || !xrProjection || !xrStereo || superResolution === 'off') {
      inlineEnhancerRef.current?.dispose();
      inlineEnhancerRef.current = undefined;
      setSuperResolutionDiagnostics(undefined);
      return;
    }
    try {
      const enhancer = new InlineVideoSuperResolution(video, canvas, {
        mode: superResolution,
        projection: xrProjection,
        stereo: xrStereo,
        onDiagnostics: setSuperResolutionDiagnostics,
        onFailure: (message) => {
          setError(message);
          setSuperResolution('off');
        },
      });
      inlineEnhancerRef.current = enhancer;
      return () => {
        enhancer.dispose();
        if (inlineEnhancerRef.current === enhancer) inlineEnhancerRef.current = undefined;
      };
    } catch (cause) {
      const timer = window.setTimeout(() => {
        setError(`无法启用实时超分：${cause instanceof Error ? cause.message : 'GPU 初始化失败'}`);
        setSuperResolution('off');
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [xrMediaId, xrMediaKind, xrProjection, xrStereo, superResolution]);

  const updateMedia = async (patch: Partial<Pick<PublicMediaItem, 'projection' | 'stereo' | 'eyeOrder' | 'yawOffset'>>) => {
    if (!data) return;
    const response = await getJson<{ item: PublicMediaItem }>(`/api/media/${mediaId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    setData((current) => current ? { ...current, item: response.item } : current);
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
    const saved = data?.progress?.position;
    if (video && saved && saved < video.duration - 5) video.currentTime = saved;
    setStatus(transport === 'direct' ? '原始文件直连' : '兼容流已就绪');
    if (video) setPlayback({ paused: video.paused, currentTime: video.currentTime, duration: video.duration || 0, muted: video.muted });
    if (stageRef.current) setDiagnostics(stageRef.current.diagnostics());
  };

  const syncPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    setPlayback({ paused: video.paused, currentTime: video.currentTime, duration: video.duration || 0, muted: video.muted });
    setCaption(activeCaption(video));
  };

  const changeSuperResolution = (mode: SuperResolutionMode) => {
    window.localStorage.setItem('localis.superResolution', mode);
    setSuperResolution(mode);
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
      superResolution,
      item: data?.item,
      transcode: data?.transcode,
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
      inlineSuperResolution: superResolutionDiagnostics,
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
          controls={item.kind === 'audio' || superResolution === 'off'}
          playsInline
          preload="metadata"
          poster={item.posterUrl}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={() => { saveProgress(false); syncPlayback(); }}
          onPlay={syncPlayback}
          onPause={() => { saveProgress(true); syncPlayback(); }}
          onVolumeChange={syncPlayback}
          onEnded={() => { saveProgress(true); syncPlayback(); }}
          onError={onMediaError}
        >
          {item.subtitleTracks.map((track, index) => (
            <track key={track.index} kind="subtitles" src={`/api/media/${item.id}/subtitles/${track.index}.vtt`} srcLang={track.language || 'und'} label={track.title || track.language || `字幕 ${index + 1}`} default={index === 0} />
          ))}
        </video>
        {item.kind === 'video' && superResolution !== 'off' && (
          <>
            <canvas ref={enhancerCanvasRef} className="super-resolution-canvas" aria-label="Localis 实时超分画面" />
            {caption && <div className="super-resolution-caption">{caption}</div>}
            <div className="super-resolution-controls" role="group" aria-label="超分播放器控制">
              <button type="button" aria-label={playback.paused ? '播放' : '暂停'} onClick={togglePlayback}>{playback.paused ? '▶' : 'Ⅱ'}</button>
              <span>{clock(playback.currentTime)}</span>
              <input aria-label="播放进度" type="range" min="0" max={Math.max(playback.duration, 0.01)} step="0.1" value={Math.min(playback.currentTime, playback.duration || 0)} onChange={(event) => { const video = videoRef.current; if (video) { video.currentTime = Number(event.target.value); syncPlayback(); } }} />
              <span>{clock(playback.duration)}</span>
              <button type="button" aria-label={playback.muted ? '取消静音' : '静音'} onClick={toggleMute}>{playback.muted ? '静音' : '声音'}</button>
              <button type="button" aria-label="全屏" onClick={() => void enterFullscreen()}>全屏</button>
            </div>
          </>
        )}
      </section>

      {error && <div className="inline-error player-inline-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}

      <section className="player-controls-panel">
        <div className="projection-controls">
          <label>投影<select value={item.projection} onChange={(event) => void updateMedia({ projection: event.target.value as PublicMediaItem['projection'] })}><option value="flat">平面</option><option value="equirect180">VR180</option><option value="equirect360">VR360</option></select></label>
          <label>立体布局<select value={item.stereo} onChange={(event) => void updateMedia({ stereo: event.target.value as PublicMediaItem['stereo'] })}><option value="mono">单目</option><option value="sbs">左右 SBS</option><option value="tb">上下 TB</option></select></label>
          <label>左右眼<select value={item.eyeOrder} disabled={item.stereo === 'mono'} onChange={(event) => void updateMedia({ eyeOrder: event.target.value as PublicMediaItem['eyeOrder'] })}><option value="lr">左 / 右</option><option value="rl">右 / 左</option></select></label>
          <label>实时超分<select aria-label="实时超分" value={superResolution} disabled={item.kind !== 'video'} onChange={(event) => changeSuperResolution(event.target.value as SuperResolutionMode)}><option value="off">关闭</option><option value="auto">自动（推荐）</option><option value="quality">高画质</option><option value="sharp">仅锐化</option></select></label>
          <label className="yaw-control">朝向<input aria-label="水平朝向" type="range" min="-3.15" max="3.15" step="0.05" value={item.yawOffset} onChange={(event) => void updateMedia({ yawOffset: Number(event.target.value) })} /></label>
          <button className="mode-button" onClick={() => void updateMedia({ yawOffset: 0 })}>重新居中</button>
          <button className="mode-button" onClick={() => { directFailed.current = transport === 'direct'; setTransport(transport === 'direct' ? 'hls' : 'direct'); }}>{transport === 'direct' ? '使用兼容流' : '尝试原文件'}</button>
          <button className="mode-button" onClick={exportDiagnostics}>导出诊断</button>
        </div>
        <button className="xr-button" disabled={!xrSupported || enteringXr || item.kind !== 'video'} onClick={() => void enterXr()}>{enteringXr ? '正在进入…' : xrSupported ? '进入沉浸模式' : '此环境不可用 WebXR'}</button>
      </section>

      {item.kind === 'video' && <p className="super-resolution-note">Localis 空间超分在当前设备的 GPU 上实时运行，不上传视频，也不宣称恢复源文件中不存在的细节。{superResolutionDiagnostics?.reason ? ` ${superResolutionDiagnostics.reason}。` : ''}</p>}

      <section className="media-details">
        <div><span>时长</span><strong>{clock(item.duration)}</strong></div>
        <div><span>画面</span><strong>{item.width ? `${item.width}×${item.height} · ${item.frameRate || '—'} fps` : '仅音频'}</strong></div>
        <div><span>编码</span><strong>{[item.videoCodec, item.audioCodec].filter(Boolean).join(' / ')}</strong></div>
        <div><span>XR 安全环境</span><strong>{diagnostics?.secureContext ? '是' : '否'}</strong></div>
        <div><span>GPU 最大纹理</span><strong>{diagnostics?.maxTextureSize || '播放后检测'}</strong></div>
        <div><span>丢帧</span><strong>{diagnostics?.droppedFrames ?? '播放后检测'}{diagnostics?.totalFrames ? ` / ${diagnostics.totalFrames}` : ''}</strong></div>
        <div><span>实时超分</span><strong>{superResolution === 'off' ? '关闭' : superResolutionDiagnostics ? `${superResolutionDiagnostics.sourceWidth}×${superResolutionDiagnostics.sourceHeight} → ${superResolutionDiagnostics.outputWidth}×${superResolutionDiagnostics.outputHeight}` : '等待首帧'}</strong></div>
      </section>
    </main>
  );
}
