import type { PublicMediaItem } from '../../server/types';
import {
  DEVICE_DISPLAY_PIPELINE_VERSION,
  type DeviceBrowserEngine,
  type DeviceBrowserProduct,
  type DeviceDisplayEnvironment,
  type ExactDisplayMediaInput,
} from './device-display-capability';

/** Kept as a compatibility alias for existing UI call sites. */
export type DeviceBrowserName = DeviceBrowserProduct;

export interface DetectedDeviceBrowser {
  browserName: DeviceBrowserName;
  browserEngine: DeviceBrowserEngine;
  browserMajor: number;
}

export interface DeviceDisplayEnvironmentInput {
  origin: string;
  userAgent: string;
  platform: string;
}

export type DeviceDisplayEnvironmentBuildFailureReason =
  | 'invalid-origin'
  | 'unsupported-browser'
  | 'invalid-platform';

export type DeviceDisplayEnvironmentBuildResult =
  | {
    ok: true;
    environment: DeviceDisplayEnvironment;
    browserName: DeviceBrowserName;
  }
  | {
    ok: false;
    reason: DeviceDisplayEnvironmentBuildFailureReason;
    detail: string;
  };

export type ExactDisplayMediaField = keyof ExactDisplayMediaInput;

export type ExactDisplayMediaInputBuildResult =
  | { ok: true; media: ExactDisplayMediaInput }
  | {
    ok: false;
    reason: 'not-video' | 'incomplete-metadata' | 'invalid-metadata';
    detail: string;
    missingFields: ExactDisplayMediaField[];
    invalidFields: ExactDisplayMediaField[];
  };

const browserPatterns: Array<{
  browserName: DeviceBrowserName;
  browserEngine: DeviceBrowserEngine;
  pattern: RegExp;
}> = [
  // Headset products must be detected before their embedded Chrome token.
  { browserName: 'meta-quest', browserEngine: 'chromium', pattern: /OculusBrowser\/([1-9]\d*)/i },
  {
    browserName: 'pico',
    browserEngine: 'chromium',
    pattern: /(?:PicoBrowser|PICO[ _-]Browser)\/([1-9]\d*)/i,
  },
  // Every browser on iOS uses WebKit even when its product token says Chrome,
  // Edge or Firefox. Keep this ahead of the desktop Chromium/Gecko patterns.
  { browserName: 'edge', browserEngine: 'webkit', pattern: /EdgiOS\/([1-9]\d*)/i },
  { browserName: 'chrome', browserEngine: 'webkit', pattern: /CriOS\/([1-9]\d*)/i },
  { browserName: 'firefox', browserEngine: 'webkit', pattern: /FxiOS\/([1-9]\d*)/i },
  { browserName: 'edge', browserEngine: 'chromium', pattern: /EdgA?\/([1-9]\d*)/i },
  { browserName: 'firefox', browserEngine: 'gecko', pattern: /Firefox\/([1-9]\d*)/i },
  {
    browserName: 'chrome',
    browserEngine: 'chromium',
    pattern: /(?:Chrome|Chromium)\/([1-9]\d*)/i,
  },
  // Chrome and Edge also contain Safari, so Safari must remain the final rule.
  { browserName: 'safari', browserEngine: 'webkit', pattern: /Version\/([1-9]\d*)(?:\.\d+)*[^]*Safari\//i },
];

// These products expose Chrome/WebKit tokens but have an independently
// changing media/XR pipeline. Treating them as Chrome would transfer a guided
// confirmation across products, so they intentionally fail closed.
const unsupportedDerivedBrowserPattern = /(?:SamsungBrowser|OPR|OPiOS|Opera|Vivaldi|YaBrowser|HuaweiBrowser|MiuiBrowser|UCBrowser|QQBrowser|DuckDuckGo|Whale|HeadlessChrome|Electron)\//i;

function isAndroidWebView(userAgent: string) {
  return /;\s*wv(?:[);]|\s)/i.test(userAgent)
    || /\bWebView\//i.test(userAgent)
    || /Version\/4\.0[^]*Chrome\//i.test(userAgent);
}

const mediaFieldLabels: Record<ExactDisplayMediaField, string> = {
  mediaId: '媒体 ID',
  size: '文件大小',
  modifiedAt: '修改时间',
  codec: '视频编码',
  profile: '编码 Profile',
  level: '编码 Level',
  pixelFormat: '像素格式',
  bitDepth: '位深',
  dynamicRange: '动态范围',
  colorPrimaries: '色彩原色',
  colorTransfer: '传递函数',
  colorSpace: '色彩矩阵',
  colorRange: '色彩范围',
  container: '封装格式',
  width: '宽度',
  height: '高度',
  fps: '帧率',
  projection: '投影格式',
  stereo: '立体布局',
};

const dynamicRanges = new Set(['sdr', 'sdr10', 'hdr10', 'hlg', 'dolby-vision', 'unknown']);
const projections = new Set(['flat', 'equirect180', 'equirect360']);
const stereoLayouts = new Set(['mono', 'sbs', 'tb']);

function positiveMajor(match: RegExpMatchArray | null) {
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : undefined;
}

/**
 * Detect only browser products whose engine and major version can be bound
 * deterministically from the User-Agent. Unknown or ambiguous products do not
 * inherit another browser's display confirmation.
 */
export function detectDeviceBrowser(userAgent: string): DetectedDeviceBrowser | undefined {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return undefined;
  const headsetPatternCount = 2;
  for (const candidate of browserPatterns) {
    const browserMajor = positiveMajor(userAgent.match(candidate.pattern));
    if (browserMajor) {
      return {
        browserName: candidate.browserName,
        browserEngine: candidate.browserEngine,
        browserMajor,
      };
    }
    // Only the two explicitly supported headset products may take precedence
    // over derived-browser/WebView rejection.
    if (browserPatterns.indexOf(candidate) === headsetPatternCount - 1
      && (unsupportedDerivedBrowserPattern.test(userAgent) || isAndroidWebView(userAgent))) {
      return undefined;
    }
  }
  return undefined;
}

export function buildDeviceDisplayEnvironment(
  input: DeviceDisplayEnvironmentInput,
): DeviceDisplayEnvironmentBuildResult {
  let origin: string;
  try {
    origin = new URL(input.origin).origin;
  } catch {
    return {
      ok: false,
      reason: 'invalid-origin',
      detail: '当前页面来源无效，无法把显示确认安全绑定到此站点。',
    };
  }
  if (origin === 'null') {
    return {
      ok: false,
      reason: 'invalid-origin',
      detail: '当前页面没有可持久绑定的网络来源，设备显示档案不会生效。',
    };
  }

  const browser = detectDeviceBrowser(input.userAgent);
  if (!browser) {
    return {
      ok: false,
      reason: 'unsupported-browser',
      detail: '无法可靠识别当前浏览器引擎及主版本，设备显示档案将保持关闭。',
    };
  }

  const platform = typeof input.platform === 'string' ? input.platform.trim().toLowerCase() : '';
  if (!platform || platform.length > 80) {
    return {
      ok: false,
      reason: 'invalid-platform',
      detail: '当前系统平台标识缺失或无效，设备显示档案将保持关闭。',
    };
  }

  return {
    ok: true,
    browserName: browser.browserName,
    environment: {
      origin,
      browserProduct: browser.browserName,
      browserEngine: browser.browserEngine,
      browserMajor: browser.browserMajor,
      platform,
      presentation: 'webxr',
      pipelineVersion: DEVICE_DISPLAY_PIPELINE_VERSION,
    },
  };
}

function isMissing(value: unknown) {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim().length === 0);
}

function isNonEmptyString(value: unknown, maximumLength: number) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength;
}

function isPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown, minimum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function normalizedDate(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

/**
 * Builds the exact fingerprint used by a display capability profile. No
 * approximate defaults are introduced: a missing probe field disables profile
 * creation so a confirmation cannot drift to a different encode.
 */
export function buildExactDisplayMediaInput(
  item: PublicMediaItem,
): ExactDisplayMediaInputBuildResult {
  if (item.kind !== 'video') {
    return {
      ok: false,
      reason: 'not-video',
      detail: '只有视频可以建立 WebXR 显示能力档案。',
      missingFields: [],
      invalidFields: [],
    };
  }

  const raw: Record<ExactDisplayMediaField, unknown> = {
    mediaId: item.id,
    size: item.size,
    modifiedAt: item.modifiedAt,
    codec: item.videoCodec,
    profile: item.videoProfile,
    level: item.videoLevel,
    pixelFormat: item.pixelFormat,
    bitDepth: item.bitDepth,
    dynamicRange: item.dynamicRange,
    colorPrimaries: item.colorPrimaries,
    colorTransfer: item.colorTransfer,
    colorSpace: item.colorSpace,
    colorRange: item.colorRange,
    container: item.container,
    width: item.width,
    height: item.height,
    fps: item.frameRate,
    projection: item.projection,
    stereo: item.stereo,
  };
  const fields = Object.keys(raw) as ExactDisplayMediaField[];
  const missingFields = fields.filter((field) => isMissing(raw[field]));
  const invalidFields = fields.filter((field) => {
    const value = raw[field];
    if (isMissing(value)) return false;
    switch (field) {
      case 'mediaId': return !isNonEmptyString(value, 512);
      case 'size': return !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
      case 'modifiedAt': return !normalizedDate(value);
      case 'codec':
      case 'profile':
      case 'pixelFormat':
      case 'colorPrimaries':
      case 'colorTransfer':
      case 'colorSpace':
      case 'colorRange': return !isNonEmptyString(value, 80);
      case 'container': return !isNonEmptyString(value, 160);
      case 'level': return !isFiniteNumber(value, 0);
      case 'bitDepth':
      case 'width':
      case 'height': return !isPositiveInteger(value);
      case 'fps': return !isFiniteNumber(value, Number.EPSILON);
      case 'dynamicRange': return typeof value !== 'string' || !dynamicRanges.has(value.trim().toLowerCase());
      case 'projection': return typeof value !== 'string' || !projections.has(value);
      case 'stereo': return typeof value !== 'string' || !stereoLayouts.has(value);
    }
  });

  if (missingFields.length > 0 || invalidFields.length > 0) {
    const parts = [
      missingFields.length > 0
        ? `缺少：${missingFields.map((field) => mediaFieldLabels[field]).join('、')}`
        : '',
      invalidFields.length > 0
        ? `无效：${invalidFields.map((field) => mediaFieldLabels[field]).join('、')}`
        : '',
    ].filter(Boolean);
    return {
      ok: false,
      reason: missingFields.length > 0 ? 'incomplete-metadata' : 'invalid-metadata',
      detail: `精确媒体元数据不完整，${parts.join('；')}。原片显示确认不会被保存。`,
      missingFields,
      invalidFields,
    };
  }

  return {
    ok: true,
    media: {
      mediaId: item.id.trim(),
      size: item.size,
      modifiedAt: normalizedDate(item.modifiedAt)!,
      codec: item.videoCodec!.trim().toLowerCase(),
      profile: item.videoProfile!.trim().toLowerCase(),
      level: item.videoLevel!,
      pixelFormat: item.pixelFormat!.trim().toLowerCase(),
      bitDepth: item.bitDepth!,
      dynamicRange: item.dynamicRange!.trim().toLowerCase(),
      colorPrimaries: item.colorPrimaries!.trim().toLowerCase(),
      colorTransfer: item.colorTransfer!.trim().toLowerCase(),
      colorSpace: item.colorSpace!.trim().toLowerCase(),
      colorRange: item.colorRange!.trim().toLowerCase(),
      container: item.container!.trim().toLowerCase(),
      width: item.width!,
      height: item.height!,
      fps: item.frameRate!,
      projection: item.projection,
      stereo: item.stereo,
    },
  };
}
