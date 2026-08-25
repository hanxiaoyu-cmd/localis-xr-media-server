export const XR_ORIGINAL_SAMPLE_MIN_WALL_MS = 10_000;
export const XR_ORIGINAL_SAMPLE_MIN_MEDIA_SECONDS = 9.5;

export interface XrOriginalSamplePoint {
  wallTime: number;
  mediaTime: number;
  totalFrames?: number;
}

/**
 * A display confirmation requires real media progression inside one direct
 * WebXR session. Wall time alone would allow a paused or stalled video to be
 * accepted, while media time alone could be satisfied by a seek.
 */
export function qualifiesXrOriginalSample(
  start: XrOriginalSamplePoint | undefined,
  end: XrOriginalSamplePoint,
  directTransport: boolean,
) {
  if (!start || !directTransport) return false;
  if (![start.wallTime, start.mediaTime, end.wallTime, end.mediaTime].every(Number.isFinite)) return false;
  if (end.wallTime - start.wallTime < XR_ORIGINAL_SAMPLE_MIN_WALL_MS) return false;
  if (end.mediaTime - start.mediaTime < XR_ORIGINAL_SAMPLE_MIN_MEDIA_SECONDS) return false;
  if (start.totalFrames !== undefined && end.totalFrames !== undefined) {
    return Number.isFinite(start.totalFrames)
      && Number.isFinite(end.totalFrames)
      && end.totalFrames > start.totalFrames;
  }
  return true;
}
