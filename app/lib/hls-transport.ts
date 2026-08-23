export type HlsTransport = 'native' | 'hls.js' | 'unsupported';

export function isAppleSafari(userAgent: string) {
  return /Safari/i.test(userAgent)
    && !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)/i.test(userAgent);
}

export function chooseHlsTransport(options: {
  nativeHls: boolean;
  mediaSourceHls: boolean;
  userAgent: string;
}): HlsTransport {
  if (options.nativeHls && isAppleSafari(options.userAgent)) return 'native';
  if (options.mediaSourceHls) return 'hls.js';
  if (options.nativeHls) return 'native';
  return 'unsupported';
}
