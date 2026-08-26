import { describe, expect, it } from 'vitest';
import { describePlaybackPath, type PlaybackPathInput } from '../app/lib/playback-path-label';

const safeSdr = {
  directPlay: true,
  compatibilityMode: 'direct' as const,
  compatibilityReason: '浏览器安全媒体。',
  dynamicRange: 'sdr' as const,
  bitDepth: 8,
  audioCodec: 'aac',
};

function input(overrides: Partial<PlaybackPathInput> = {}): PlaybackPathInput {
  return {
    compatibility: safeSdr,
    transport: 'hls',
    superResolution: 'off',
    ...overrides,
  };
}

describe('playback path labels', () => {
  it('lets direct transport truthfully override a saved enhancement preference', () => {
    expect(describePlaybackPath(input({
      transport: 'direct',
      superResolution: 'ultra',
      serverEnhancement: { state: 'running', generationState: 'processing' },
    }))).toMatchObject({
      kind: 'original-direct',
      label: '原片直出',
      state: 'active',
    });
  });

  it('marks direct HDR as an unprocessed browser attempt', () => {
    const identity = describePlaybackPath(input({
      transport: 'direct',
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        compatibilityReason: 'HDR 需要兼容流。',
        dynamicRange: 'dolby-vision',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({
      kind: 'original-hdr-attempt',
      label: '原始 HDR/10-bit 实验尝试',
      presentationAssurance: 'unverified',
      presentationAssuranceLabel: '设备链路未认证',
      presentationVerified: false,
    });
    expect(identity.description).toContain('杜比视界 10-bit');
    expect(identity.description).toContain('不做色调映射');
    expect(identity.description).toContain('不宣称 HDR、位深或色彩已正确呈现');
  });

  it.each([
    ['guided-user', '用户引导确认', false],
    ['instrumented', '仪器验证', true],
    ['vendor', '厂商认证', true],
  ] as const)('reports %s presentation assurance without overstating device validation', (assurance, label, verified) => {
    const identity = describePlaybackPath(input({
      transport: 'direct',
      presentationAssurance: assurance,
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        dynamicRange: 'hdr10',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({
      label: '原始 HDR/10-bit 实验尝试',
      presentationAssurance: assurance,
      presentationAssuranceLabel: label,
      presentationVerified: verified,
    });
    if (assurance === 'guided-user') expect(identity.description).toContain('不称为已验证');
    else expect(identity.description).toContain('可标记为已验证呈现');
  });

  it('labels direct high-bit-depth SDR as an experimental original presentation', () => {
    const identity = describePlaybackPath(input({
      transport: 'direct',
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'video-transcode',
        dynamicRange: 'sdr10',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({
      kind: 'original-hdr-attempt',
      label: '原始 HDR/10-bit 实验尝试',
      presentationVerified: false,
    });
    expect(identity.description).toContain('高位深 SDR 10-bit');
    expect(identity.description).toContain('不做色调映射或位深转换');
  });

  it('does not claim color accuracy for a direct source with incomplete metadata', () => {
    const identity = describePlaybackPath(input({
      transport: 'direct',
      presentationAssurance: 'vendor',
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'video-transcode',
        dynamicRange: 'unknown',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({
      kind: 'original-color-attempt',
      label: '原始色彩实验尝试',
      presentationAssurance: 'unverified',
      presentationVerified: false,
    });
    expect(identity.description).toContain('源色彩元数据不完整');
    expect(identity.description).toContain('不宣称色彩准确');
  });

  it('distinguishes HLS remux from audio compatibility conversion', () => {
    expect(describePlaybackPath(input({
      compatibility: { ...safeSdr, directPlay: false, compatibilityMode: 'remux' },
    }))).toMatchObject({ kind: 'video-copy', label: '视频直拷贝' });

    const audioCompatible = describePlaybackPath(input({
      compatibility: { ...safeSdr, directPlay: false, compatibilityMode: 'audio-transcode', audioCodec: 'dts' },
    }));
    expect(audioCompatible).toMatchObject({
      kind: 'video-copy-audio-compatible',
      label: '视频直拷贝 · 音频兼容',
    });
    expect(audioCompatible.description).toContain('AAC 立体声');

    expect(describePlaybackPath(input({
      compatibility: { ...safeSdr, compatibilityMode: 'direct', audioCodec: 'mp3' },
    }))).toMatchObject({ kind: 'video-copy-audio-compatible' });
    expect(describePlaybackPath(input({
      compatibility: { ...safeSdr, directPlay: false, compatibilityMode: 'remux', audioCodec: 'mp3' },
    }))).toMatchObject({ kind: 'video-copy-audio-compatible' });
  });

  it('labels SDR video conversion as H.264 compatibility transcoding', () => {
    const identity = describePlaybackPath(input({
      compatibility: { ...safeSdr, directPlay: false, compatibilityMode: 'video-transcode' },
    }));
    expect(identity).toMatchObject({
      kind: 'h264-compatible-transcode',
      label: 'H.264 兼容转码',
    });
    expect(identity.description).toContain('8-bit H.264');
  });

  it('uses the actual forced server mode instead of calling it a video copy', () => {
    const identity = describePlaybackPath(input({
      compatibility: safeSdr,
      serverEnhancement: {
        state: 'running',
        mode: 'transcode',
        forcedCompatibility: true,
      },
    }));
    expect(identity).toMatchObject({
      kind: 'h264-compatible-transcode',
      label: 'H.264 兼容转码',
      state: 'processing',
    });
    expect(identity.description).toContain('4K/60 fps');
  });

  it('labels the HDR compatibility stream as an explicit HDR-to-SDR path', () => {
    const identity = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        compatibilityReason: 'HDR 需要兼容流。',
        dynamicRange: 'hdr10',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({ kind: 'hdr-to-sdr', label: 'HDR → SDR' });
    expect(identity.description).toContain('SDR BT.709');
    expect(identity.description).toContain('10-bit → 8-bit SDR');
    expect(identity.description).toContain('抖动');
    expect(identity.description).toContain('不可逆位深损失');
  });

  it.each([
    [10, '10-bit → 8-bit SDR'],
    [12, '12-bit → 8-bit SDR'],
  ] as const)('makes %i-bit SDR precision loss explicit in the compatibility path', (bitDepth, label) => {
    const identity = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'video-transcode',
        dynamicRange: 'sdr10',
        bitDepth,
      },
    }));
    expect(identity).toMatchObject({ kind: 'high-bit-depth-to-sdr8', label });
    expect(identity.description).toContain('使用抖动降为 8-bit');
    expect(identity.description).toContain('位深信息会不可逆损失');
  });

  it('describes unknown color metadata as a conservative 8-bit output', () => {
    const identity = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'video-transcode',
        dynamicRange: 'unknown',
        bitDepth: 10,
      },
    }));
    expect(identity).toMatchObject({
      kind: 'unknown-color-to-8bit',
      label: '未知色彩 → 8-bit 兼容',
    });
    expect(identity.description).toContain('源色彩元数据不完整');
    expect(identity.description).toContain('8-bit H.264/AAC 色彩未知兼容流');
    expect(identity.description).toContain('不保证亮度、动态范围或色彩正确');
    expect(identity.description).not.toContain('BT.709');
  });

  it('never claims a generic Dolby Vision compatibility stream is certified SDR', () => {
    const unknownBase = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        dynamicRange: 'dolby-vision',
        bitDepth: 10,
        colorTransfer: undefined,
      },
    }));
    expect(unknownBase).toMatchObject({
      kind: 'dolby-vision-compatibility',
      label: '杜比视界兼容（未认证）',
    });
    expect(unknownBase.description).toContain('色彩未知兼容流');
    expect(unknownBase.description).not.toContain('映射为 8-bit BT.709');

    const pqBase = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        dynamicRange: 'dolby-vision',
        bitDepth: 10,
        colorTransfer: 'smpte2084',
      },
    }));
    expect(pqBase.description).toContain('仅按明确的基底传递函数尝试映射');
    expect(pqBase.description).toContain('不执行 Dolby Vision 动态元数据重建');
  });

  it.each([
    ['standard', 'standard-enhancement', '标准增强'],
    ['high', 'high-enhancement', '高增强'],
    ['ultra', 'ultra-enhancement', '极致增强'],
    ['ai', 'ai-enhancement', 'AI 增强'],
  ] as const)('identifies the %s enhancement path', (level, kind, label) => {
    const identity = describePlaybackPath(input({
      superResolution: level,
      serverEnhancement: {
        state: 'running',
        generationState: 'processing',
        enhancementBackend: level === 'ai' ? 'Real-ESRGAN NCNN Vulkan' : 'FFmpeg zscale + CAS',
        plan: { available: true, activeMode: 'upscale' },
      },
    }));
    expect(identity).toMatchObject({ kind, label, state: 'processing', stateLabel: '生成中' });
    expect(identity.description).toContain(level === 'ai' ? 'AI 重建' : '放大与锐化');
  });

  it('combines enhancement with the real HDR-to-SDR transformation', () => {
    const identity = describePlaybackPath(input({
      compatibility: {
        ...safeSdr,
        directPlay: false,
        compatibilityMode: 'tone-map',
        compatibilityReason: 'HDR 需要兼容流。',
        dynamicRange: 'hlg',
        bitDepth: 10,
      },
      superResolution: 'high',
      serverEnhancement: {
        state: 'ready',
        generationState: 'complete',
        plan: { available: true, activeMode: 'sharpen' },
      },
    }));
    expect(identity).toMatchObject({ kind: 'high-enhancement', state: 'ready', stateLabel: '已就绪' });
    expect(identity.description).toContain('原尺寸锐化');
    expect(identity.description).toContain('HDR 同时映射为 SDR BT.709');
    expect(identity.description).toContain('10-bit → 8-bit SDR');
    expect(identity.description).toContain('抖动');
  });

  it('reports unavailable and failed enhancement requests without claiming an active output', () => {
    expect(describePlaybackPath(input({
      superResolution: 'ai',
      serverEnhancement: {
        state: 'unavailable',
        error: 'AI 模型未安装',
        plan: { available: true, activeMode: 'upscale' },
      },
    }))).toMatchObject({
      kind: 'ai-enhancement',
      state: 'unavailable',
      description: '请求的AI 增强不可用：AI 模型未安装',
    });

    expect(describePlaybackPath(input({
      superResolution: 'ultra',
      serverEnhancement: {
        state: 'failed',
        error: '编码器失败',
        plan: { available: true, activeMode: 'upscale' },
      },
    }))).toMatchObject({
      kind: 'ultra-enhancement',
      state: 'failed',
      description: '极致增强生成失败：编码器失败',
    });

    expect(describePlaybackPath(input({
      superResolution: 'high',
      serverEnhancement: {
        state: 'idle',
        plan: { available: false, activeMode: 'off', reason: '超过 Level 5.2' },
      },
    }))).toMatchObject({ state: 'unavailable', description: '请求的高增强不可用：超过 Level 5.2' });
  });

  it('does not mutate frozen input data', () => {
    const frozen = Object.freeze(input({
      compatibility: Object.freeze({ ...safeSdr }),
      superResolution: 'standard',
      serverEnhancement: Object.freeze({ state: 'idle' }),
    }));
    expect(() => describePlaybackPath(frozen)).not.toThrow();
    expect(frozen.transport).toBe('hls');
  });

  it.each([
    [{ ...safeSdr, compatibilityMode: 'direct' as const }, 'video-copy'],
    [{ ...safeSdr, directPlay: false, compatibilityMode: 'remux' as const }, 'video-copy'],
    [{ ...safeSdr, directPlay: false, compatibilityMode: 'audio-transcode' as const, audioCodec: 'dts' }, 'video-copy-audio-compatible'],
    [{ ...safeSdr, directPlay: false, compatibilityMode: 'video-transcode' as const }, 'h264-compatible-transcode'],
    [{
      ...safeSdr,
      directPlay: false,
      compatibilityMode: 'tone-map' as const,
      dynamicRange: 'hdr10' as const,
      bitDepth: 10,
    }, 'hdr-to-sdr'],
  ] as const)('keeps every non-enhanced HLS path pending until its server stream is ready', (compatibility, kind) => {
    expect(describePlaybackPath(input({
      compatibility,
      serverEnhancement: { state: 'idle', generationState: 'waiting' },
    }))).toMatchObject({ kind, state: 'requested', stateLabel: '准备中' });
  });

  it.each([
    [undefined, 'requested', '准备中'],
    [{ state: 'idle', generationState: 'waiting' }, 'requested', '准备中'],
    [{ state: 'preparing' }, 'requested', '准备中'],
    [{ state: 'preparing', generationState: 'processing' }, 'processing', '生成中'],
    [{ state: 'running' }, 'processing', '生成中'],
    [{ state: 'ready' }, 'ready', '已就绪'],
    [{ state: 'running', generationState: 'complete' }, 'ready', '已就绪'],
    [{ state: 'failed', error: '转码失败' }, 'failed', '生成失败'],
    [{ state: 'unavailable', error: '编码器不可用' }, 'unavailable', '不可用'],
  ] as const)('maps non-enhanced HLS server status %# to %s', (serverEnhancement, state, stateLabel) => {
    expect(describePlaybackPath(input({ serverEnhancement }))).toMatchObject({
      kind: 'video-copy',
      state,
      stateLabel,
    });
  });
});
