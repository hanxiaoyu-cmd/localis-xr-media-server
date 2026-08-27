import { XrVideoStage, type XrVideoOptions } from '../../app/lib/xr-video-stage';

type MediaKind = 'video' | 'audio';
type Projection = 'flat' | 'equirect180' | 'equirect360';
type StereoLayout = 'mono' | 'sbs' | 'tb';
type EyeOrder = 'lr' | 'rl';

interface SubtitleTrack {
  index: number;
  language?: string;
  title?: string;
}

interface MediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  fileName: string;
  duration: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  projection: Projection;
  stereo: StereoLayout;
  eyeOrder: EyeOrder;
  yawOffset: number;
  streamUrl: string;
  posterUrl?: string;
  subtitleTracks: SubtitleTrack[];
}

interface PlaybackProgress {
  mediaId: string;
  position: number;
  duration: number;
  updatedAt: string;
}

interface LibraryResponse {
  items: MediaItem[];
  progress: Record<string, PlaybackProgress>;
}

interface PairStatus {
  paired: boolean;
  pairingRequired: boolean;
}

interface ApiErrorPayload {
  error?: string;
  message?: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class PairingRequiredError extends Error {}

const resolvedAppRoot = document.querySelector<HTMLElement>('#app');
if (!resolvedAppRoot) throw new Error('app_root_missing');
const appRoot: HTMLElement = resolvedAppRoot;

let items: MediaItem[] = [];
let progressById: Record<string, PlaybackProgress> = {};
let currentItem: MediaItem | undefined;
let currentVideo: HTMLVideoElement | undefined;
let currentStage: XrVideoStage | undefined;
let currentPlayerMessage: HTMLElement | undefined;
let progressTimer: number | undefined;
let lastProgressSaveAt = 0;
let viewEpoch = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function append(parent: Node, ...children: Array<Node | undefined>) {
  for (const child of children) if (child) parent.appendChild(child);
}

function safeSameOriginUrl(value: string) {
  const url = new URL(value, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('服务器返回了非同源资源地址，已阻止加载。');
  return url.href;
}

function apiUrl(path: string) {
  if (!path.startsWith('/api/')) throw new Error('只允许访问 Localis API。');
  return safeSameOriginUrl(path);
}

async function requestJson<T>(path: string, init: RequestInit = {}, handleUnauthorized = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({})) as ApiErrorPayload;
  if (response.status === 401 && handleUnauthorized) {
    renderPairing('配对会话已失效，请重新输入安卓服务器上显示的六位配对码。');
    throw new PairingRequiredError();
  }
  if (!response.ok) {
    throw new ApiError(response.status, body.error || `HTTP_${response.status}`, body.message || body.error || `HTTP ${response.status}`);
  }
  return body as T;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function mediaDescription(item: MediaItem) {
  const resolution = item.width && item.height ? `${item.width}×${item.height}` : item.kind === 'audio' ? '音频' : '视频';
  const codec = (item.videoCodec || item.audioCodec || '原片').toUpperCase();
  const projection = item.projection === 'equirect180' ? 'VR180' : item.projection === 'equirect360' ? 'VR360' : '平面';
  const stereo = item.stereo === 'sbs' ? 'SBS' : item.stereo === 'tb' ? 'TB' : '单目';
  return `${projection} · ${stereo} · ${resolution} · ${codec}`;
}

function securityNotice() {
  if (window.location.protocol === 'https:') return undefined;
  const notice = element('div', 'notice');
  const copy = element('span');
  const strong = element('strong', undefined, '当前是 HTTP。');
  append(copy, strong, document.createTextNode('普通原片播放可用；WebXR 需要头显浏览器直接信任的 HTTPS 地址。'));
  notice.appendChild(copy);
  return notice;
}

function brand() {
  const wrapper = element('div', 'brand');
  const mark = element('span', 'brand-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(element('i'));
  append(wrapper, mark, document.createTextNode('Localis Headset'));
  return wrapper;
}

function disposePlayer() {
  const video = currentVideo;
  currentVideo = undefined;
  currentItem = undefined;
  currentPlayerMessage = undefined;
  if (progressTimer !== undefined) {
    window.clearInterval(progressTimer);
    progressTimer = undefined;
  }
  currentStage?.dispose();
  currentStage = undefined;
  video?.pause();
  video?.removeAttribute('src');
  video?.load();
}

function replaceView(view: HTMLElement) {
  appRoot.replaceChildren(view);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderLoading(message: string) {
  disposePlayer();
  const main = element('main', 'center-state');
  const mark = element('span', 'brand-mark brand-mark-large');
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(element('i'));
  append(main, mark, element('p', undefined, message));
  replaceView(main);
}

function renderFatal(title: string, detail: string, retry?: () => void) {
  disposePlayer();
  const main = element('main', 'center-state');
  const card = element('section', 'pair-card');
  append(card, brand(), element('h1', undefined, title), element('p', undefined, detail));
  if (retry) {
    const button = element('button', 'primary', '重试');
    button.type = 'button';
    button.addEventListener('click', retry);
    card.appendChild(button);
  }
  main.appendChild(card);
  replaceView(main);
}

function renderPairing(message = '') {
  viewEpoch += 1;
  disposePlayer();
  document.title = '设备配对 · Localis Headset';
  const main = element('main', 'center-state');
  const card = element('section', 'pair-card');
  append(card, brand(), element('h1', undefined, '连接私人媒体库'));
  const description = element('p', undefined, '输入运行 Localis Server 的安卓设备上显示的六位配对码。会话只保存在当前浏览器。');
  const form = element('form', 'pair-form');
  const label = element('label', undefined, '六位配对码');
  label.htmlFor = 'pair-code';
  const input = element('input', 'pair-input');
  input.id = 'pair-code';
  input.type = 'password';
  input.inputMode = 'numeric';
  input.autocomplete = 'one-time-code';
  input.maxLength = 6;
  input.pattern = '[0-9]{6}';
  input.setAttribute('aria-describedby', 'pair-error');
  const submit = element('button', 'primary', '配对并进入');
  submit.type = 'submit';
  const error = element('p', 'form-error', message);
  error.id = 'pair-error';
  append(form, label, input, submit, error);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      error.textContent = '请输入六位数字配对码。';
      input.focus();
      return;
    }
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = '正在配对…';
    error.textContent = '';
    void requestJson('/api/pair/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }, false).then(() => loadLibrary()).catch((cause: unknown) => {
      const apiError = cause instanceof ApiError ? cause : undefined;
      error.textContent = apiError?.code === 'invalid_pairing_code'
        ? '配对码不正确，请查看安卓服务器本次启动显示的数字。'
        : apiError?.code === 'too_many_attempts'
          ? '尝试次数过多，请稍后再试。'
          : cause instanceof Error ? cause.message : '配对失败。';
      input.disabled = false;
      submit.disabled = false;
      submit.textContent = '配对并进入';
      input.select();
    });
  });
  append(card, description, securityNotice(), form);
  main.appendChild(card);
  replaceView(main);
  window.setTimeout(() => input.focus(), 0);
}

function posterFor(item: MediaItem) {
  const poster = element('div', 'poster');
  if (item.posterUrl) {
    try {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.src = safeSameOriginUrl(item.posterUrl);
      image.addEventListener('error', () => image.remove());
      poster.appendChild(image);
    } catch {
      // A malformed or cross-origin poster is ignored without weakening the
      // same-origin rule used by authenticated media.
    }
  }
  poster.appendChild(element('span', 'poster-fallback', item.kind === 'audio' ? 'AUDIO' : item.projection === 'flat' ? 'ORIGINAL' : item.projection === 'equirect180' ? 'VR180' : 'VR360'));
  poster.appendChild(element('span', 'play-disc'));
  const saved = progressById[item.id];
  if (saved?.duration > 0 && saved.position > 0) {
    const track = element('span', 'card-progress');
    const value = element('i');
    value.style.setProperty('--progress', `${Math.min(100, saved.position / saved.duration * 100)}%`);
    track.appendChild(value);
    poster.appendChild(track);
  }
  return poster;
}

function renderMediaGrid(grid: HTMLElement, query: string, count: HTMLElement) {
  const normalized = query.trim().toLocaleLowerCase();
  const visible = normalized
    ? items.filter((item) => `${item.title} ${item.fileName}`.toLocaleLowerCase().includes(normalized))
    : items;
  count.textContent = `${visible.length} 个项目`;
  grid.replaceChildren();
  if (visible.length === 0) {
    grid.appendChild(element('div', 'empty', normalized ? '没有找到匹配的媒体。' : '媒体库暂无内容，请先在安卓服务器中选择媒体文件夹。'));
    return;
  }
  for (const item of visible) {
    const button = element('button', 'media-card');
    button.type = 'button';
    button.setAttribute('aria-label', `播放 ${item.title}`);
    const copy = element('div', 'media-copy');
    const saved = progressById[item.id];
    append(copy, element('h3', undefined, item.title), element('p', undefined, `${mediaDescription(item)} · ${saved?.position ? `续播 ${formatDuration(saved.position)}` : formatDuration(item.duration)}`));
    append(button, posterFor(item), copy);
    button.addEventListener('click', () => renderPlayer(item));
    grid.appendChild(button);
  }
}

function renderLibrary() {
  disposePlayer();
  viewEpoch += 1;
  document.title = '媒体库 · Localis Headset';
  const main = element('main', 'shell');
  const topbar = element('header', 'topbar');
  append(topbar, brand(), element('span', 'origin-pill', window.location.origin));
  const hero = element('section', 'hero');
  const copy = element('div');
  append(copy, element('p', 'eyebrow', 'PRIVATE XR CINEMA'), element('h1', undefined, '原片直达头显。'), element('p', undefined, '这是只保留配对、搜索、原片播放与 WebXR 的轻量入口。媒体与凭据不离开当前 Localis 来源。'));
  const search = element('label', 'search');
  const searchInput = element('input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索片名或文件名';
  searchInput.setAttribute('aria-label', '搜索媒体');
  append(search, element('span', undefined, '⌕'), searchInput);
  append(hero, copy, search);
  const heading = element('div', 'library-heading');
  const count = element('span');
  append(heading, element('h2', undefined, '媒体库'), count);
  const grid = element('section', 'media-grid');
  grid.setAttribute('aria-label', '媒体列表');
  searchInput.addEventListener('input', () => renderMediaGrid(grid, searchInput.value, count));
  append(main, topbar, securityNotice(), hero, heading, grid);
  replaceView(main);
  renderMediaGrid(grid, '', count);
}

async function saveProgress(force = false, keepalive = false) {
  const item = currentItem;
  const video = currentVideo;
  if (!item || !video || !Number.isFinite(video.currentTime)) return false;
  const now = Date.now();
  if (!force && (video.paused || now - lastProgressSaveAt < 7_500)) return true;
  lastProgressSaveAt = now;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : item.duration;
  try {
    const result = await requestJson<{ progress: PlaybackProgress }>(`/api/progress/${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      keepalive,
      body: JSON.stringify({ position: video.currentTime, duration }),
    });
    progressById[item.id] = result.progress;
    return true;
  } catch (cause) {
    if (cause instanceof PairingRequiredError) return false;
    if (currentItem === item && currentPlayerMessage) currentPlayerMessage.textContent = '续播进度暂时无法保存，播放仍可继续。';
    return false;
  }
}

async function checkPairingAfterMediaError(item: MediaItem) {
  try {
    const status = await requestJson<PairStatus>('/api/pair/status', {}, false);
    if (!status.paired) {
      renderPairing('配对会话已失效，请重新配对后继续播放。');
      return;
    }
  } catch {
    // The actionable direct-play error below remains visible when the status
    // probe itself cannot reach the server.
  }
  if (currentItem === item && currentPlayerMessage) {
    currentPlayerMessage.textContent = '当前头显浏览器无法直放这个原片。此轻量页面不会启用 HLS 或转码回退。';
    currentPlayerMessage.classList.add('player-error');
  }
}

function initializeXr(item: MediaItem, video: HTMLVideoElement, button: HTMLButtonElement) {
  if (item.kind !== 'video') {
    button.disabled = true;
    button.textContent = '音频不支持 WebXR';
    return;
  }
  if (!window.isSecureContext) {
    button.disabled = true;
    button.textContent = 'WebXR 需要可信 HTTPS';
    return;
  }
  if (!navigator.xr) {
    button.disabled = true;
    button.textContent = '浏览器不支持 WebXR';
    return;
  }

  const options: XrVideoOptions = {
    projection: item.projection,
    stereo: item.stereo,
    eyeOrder: item.eyeOrder,
    yawOffset: item.yawOffset,
  };
  let stage: XrVideoStage;
  try {
    stage = new XrVideoStage(video, options, (active) => {
      if (currentStage !== stage) return;
      button.disabled = active;
      button.classList.toggle('active', active);
      button.textContent = active ? '沉浸模式运行中' : '进入沉浸模式';
    });
  } catch {
    button.disabled = true;
    button.textContent = '无法初始化 WebGL';
    return;
  }
  currentStage = stage;
  button.disabled = true;
  button.textContent = '正在检查 WebXR…';
  void stage.isSupported().then((supported) => {
    if (currentStage !== stage) return;
    button.disabled = !supported;
    button.textContent = supported ? '进入沉浸模式' : '当前头显不支持 WebXR';
  }).catch(() => {
    if (currentStage !== stage) return;
    button.disabled = true;
    button.textContent = '无法检查 WebXR';
  });
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '正在进入…';
    void stage.enter().catch((cause: unknown) => {
      if (currentStage !== stage) return;
      button.disabled = false;
      button.textContent = '进入沉浸模式';
      if (currentPlayerMessage) {
        currentPlayerMessage.textContent = cause instanceof Error ? cause.message : '无法进入 WebXR。';
        currentPlayerMessage.classList.add('player-error');
      }
    });
  });
}

function renderPlayer(item: MediaItem) {
  disposePlayer();
  viewEpoch += 1;
  currentItem = item;
  lastProgressSaveAt = 0;
  document.title = `${item.title} · Localis Headset`;
  const main = element('main', 'player-shell');
  const topbar = element('header', 'player-topbar');
  const back = element('button', 'secondary back-button', '← 媒体库');
  back.type = 'button';
  const title = element('div');
  append(title, element('h1', undefined, item.title), element('p', undefined, item.fileName));
  append(topbar, back, title, element('span', 'connection-state', '原片同源直连'));
  const frame = element('section', 'video-frame');
  const video = element('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('webkit-playsinline', 'true');
  currentVideo = video;
  try {
    video.src = safeSameOriginUrl(item.streamUrl);
    if (item.posterUrl) video.poster = safeSameOriginUrl(item.posterUrl);
  } catch (cause) {
    currentPlayerMessage = element('span', 'player-error', cause instanceof Error ? cause.message : '媒体地址无效。');
  }
  for (const [position, trackInfo] of item.subtitleTracks.entries()) {
    const track = element('track');
    track.kind = 'subtitles';
    track.src = apiUrl(`/api/media/${encodeURIComponent(item.id)}/subtitles/${trackInfo.index}.vtt`);
    track.srclang = trackInfo.language || 'und';
    track.label = trackInfo.title || trackInfo.language || `字幕 ${position + 1}`;
    track.default = position === 0;
    video.appendChild(track);
  }
  frame.appendChild(video);
  const panel = element('section', 'player-panel');
  const panelCopy = element('div', 'player-panel-copy');
  const message = currentPlayerMessage || element('span', undefined, '仅播放服务器提供的原始媒体；不启用 HLS、超分、AI 或云盘管理。');
  currentPlayerMessage = message;
  append(panelCopy, element('strong', undefined, mediaDescription(item)), message);
  const xrButton = element('button', 'primary xr-button', '正在检查 WebXR…');
  xrButton.type = 'button';
  xrButton.disabled = true;
  append(panel, panelCopy, xrButton);
  append(main, topbar, securityNotice(), frame, panel);
  replaceView(main);

  const saved = progressById[item.id]?.position || 0;
  let resumeApplied = false;
  video.addEventListener('loadedmetadata', () => {
    if (!resumeApplied && saved > 0 && Number.isFinite(video.duration)) {
      resumeApplied = true;
      video.currentTime = Math.min(saved, Math.max(0, video.duration - 0.25));
    }
  });
  video.addEventListener('timeupdate', () => { void saveProgress(false); });
  video.addEventListener('pause', () => { void saveProgress(true); });
  video.addEventListener('ended', () => { void saveProgress(true); });
  video.addEventListener('error', () => { void checkPairingAfterMediaError(item); });
  progressTimer = window.setInterval(() => { void saveProgress(false); }, 8_000);
  back.addEventListener('click', () => {
    back.disabled = true;
    void saveProgress(true).then(() => {
      if (currentItem !== item) return;
      void loadLibrary();
    });
  });
  initializeXr(item, video, xrButton);
}

async function loadLibrary() {
  const epoch = ++viewEpoch;
  renderLoading('正在读取媒体库…');
  try {
    const library = await requestJson<LibraryResponse>('/api/library');
    if (epoch !== viewEpoch) return;
    items = library.items;
    progressById = library.progress;
    renderLibrary();
  } catch (cause) {
    if (cause instanceof PairingRequiredError || epoch !== viewEpoch) return;
    renderFatal('无法读取媒体库', cause instanceof Error ? cause.message : '请检查 Localis 服务。', () => { void loadLibrary(); });
  }
}

async function boot() {
  if (!['http:', 'https:'].includes(window.location.protocol) || window.location.origin === 'null') {
    renderFatal('请从 Android Server 打开', '这个页面必须由与 Localis API 相同的 HTTP/HTTPS 来源提供，不能直接以 file:// 打开。');
    return;
  }
  renderLoading('正在检查配对状态…');
  try {
    const status = await requestJson<PairStatus>('/api/pair/status', {}, false);
    if (status.paired) await loadLibrary();
    else renderPairing();
  } catch (cause) {
    renderFatal('无法连接 Localis', cause instanceof Error ? cause.message : '请检查服务地址与网络。', () => { void boot(); });
  }
}

window.addEventListener('pagehide', () => { void saveProgress(true, true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void saveProgress(true, true);
});

void boot();
