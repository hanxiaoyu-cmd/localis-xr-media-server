import * as THREE from 'three';
import type { Projection, StereoLayout } from '@/server/types';

export type SuperResolutionMode = 'off' | 'auto' | 'quality' | 'sharp';
export type ActiveSuperResolutionMode = 'off' | 'upscale' | 'sharp';

export interface SuperResolutionPlan {
  requestedMode: SuperResolutionMode;
  activeMode: ActiveSuperResolutionMode;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  scale: number;
  qualityTaps: boolean;
  sharpness: number;
  reason?: string;
}

export interface SuperResolutionDiagnostics extends SuperResolutionPlan {
  renderCount: number;
  lastRenderMs?: number;
  contextLost: boolean;
}

export interface SuperResolutionRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function stereoSamplingBounds(stereo: StereoLayout, effectiveEye: 0 | 1, textureWidth: number, textureHeight: number) {
  if (stereo === 'sbs') {
    const inset = 0.5 / Math.max(2, textureWidth);
    const minimum = effectiveEye * 0.5 + inset;
    return { minimum, span: 0.5 - inset * 2 };
  }
  if (stereo === 'tb') {
    const inset = 0.5 / Math.max(2, textureHeight);
    const minimum = (effectiveEye === 0 ? 0.5 : 0) + inset;
    return { minimum, span: 0.5 - inset * 2 };
  }
  return { minimum: 0, span: 1 };
}

const DEFAULT_MAX_PIXELS = 12_000_000;

function evenFloor(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function superResolutionRegion(stereo: StereoLayout, u: number, v: number): SuperResolutionRegion {
  if (stereo === 'sbs') return u < 0.5
    ? { minX: 0, minY: 0, maxX: 0.5, maxY: 1 }
    : { minX: 0.5, minY: 0, maxX: 1, maxY: 1 };
  if (stereo === 'tb') return v < 0.5
    ? { minX: 0, minY: 0, maxX: 1, maxY: 0.5 }
    : { minX: 0, minY: 0.5, maxX: 1, maxY: 1 };
  return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

export function planSuperResolution(
  sourceWidth: number,
  sourceHeight: number,
  requestedMode: SuperResolutionMode,
  maxTextureSize = 8192,
  maxPixels = DEFAULT_MAX_PIXELS,
  stereo: StereoLayout = 'mono',
): SuperResolutionPlan {
  const width = Math.max(0, Math.floor(sourceWidth));
  const height = Math.max(0, Math.floor(sourceHeight));
  const unavailable: SuperResolutionPlan = {
    requestedMode,
    activeMode: 'off',
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: width,
    outputHeight: height,
    scale: 1,
    qualityTaps: false,
    sharpness: 0,
    reason: width && height ? undefined : '等待视频尺寸',
  };
  if (!width || !height || requestedMode === 'off') return unavailable;
  if (width > maxTextureSize || height > maxTextureSize || width * height > maxPixels) {
    return {
      ...unavailable,
      reason: '源画面超过 GPU 安全纹理预算，已保留原生播放',
    };
  }

  const eyeWidth = stereo === 'sbs' ? width / 2 : width;
  const eyeHeight = stereo === 'tb' ? height / 2 : height;
  const longestEyeEdge = Math.max(eyeWidth, eyeHeight);
  let requestedScale = 1;
  let sharpness = 0.2;
  let qualityTaps = false;
  if (requestedMode === 'auto') {
    requestedScale = longestEyeEdge <= 1920 ? 1.5 : longestEyeEdge <= 2560 ? 1.3 : 1;
    sharpness = requestedScale > 1 ? 0.22 : 0.14;
    qualityTaps = requestedScale > 1;
  } else if (requestedMode === 'quality') {
    requestedScale = 1.5;
    sharpness = 0.26;
    qualityTaps = true;
  } else {
    requestedScale = 1;
    sharpness = 0.18;
  }

  const textureScale = Math.min(maxTextureSize / width, maxTextureSize / height);
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const scale = Math.max(1, Math.min(requestedScale, textureScale, pixelScale));
  const outputWidth = evenFloor(width * scale);
  const outputHeight = evenFloor(height * scale);
  const effectiveScale = Math.min(outputWidth / width, outputHeight / height);
  const activeMode: ActiveSuperResolutionMode = effectiveScale > 1.03 ? 'upscale' : 'sharp';
  const limited = effectiveScale + 0.01 < requestedScale;

  return {
    requestedMode,
    activeMode,
    sourceWidth: width,
    sourceHeight: height,
    outputWidth,
    outputHeight,
    scale: Math.round(effectiveScale * 100) / 100,
    qualityTaps,
    sharpness,
    reason: limited ? '已按 GPU 最大纹理或 1200 万像素上限调整' : activeMode === 'sharp' && requestedMode !== 'sharp' ? '源画面已很大，自动改为轻量锐化' : undefined,
  };
}

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const spatialSuperResolutionFragmentShader = /* glsl */`
  precision highp float;
  precision highp int;
  uniform sampler2D uMap;
  uniform vec2 uSourceSize;
  uniform float uSharpness;
  uniform float uQualityTaps;
  uniform float uStereoMode;
  uniform float uWrapX;
  varying vec2 vUv;

  float localisLuma(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  vec4 eyeBounds(vec2 origin) {
    if (uStereoMode < 0.5) return vec4(0.0, 0.0, 1.0, 1.0);
    if (uStereoMode < 1.5) {
      return origin.x < 0.5 ? vec4(0.0, 0.0, 0.5, 1.0) : vec4(0.5, 0.0, 1.0, 1.0);
    }
    return origin.y < 0.5 ? vec4(0.0, 0.0, 1.0, 0.5) : vec4(0.0, 0.5, 1.0, 1.0);
  }

  vec2 safeUv(vec2 coordinate, vec2 origin) {
    vec4 bounds = eyeBounds(origin);
    vec2 halfTexel = 0.5 / uSourceSize;
    if (uWrapX > 0.5) {
      float width = bounds.z - bounds.x;
      coordinate.x = bounds.x + mod(mod(coordinate.x - bounds.x, width) + width, width);
    } else {
      coordinate.x = clamp(coordinate.x, bounds.x + halfTexel.x, bounds.z - halfTexel.x);
    }
    coordinate.y = clamp(coordinate.y, bounds.y + halfTexel.y, bounds.w - halfTexel.y);
    return coordinate;
  }

  vec3 source(vec2 coordinate, vec2 origin) {
    return texture2D(uMap, safeUv(coordinate, origin)).rgb;
  }

  vec3 srgbToLinear(vec3 value) {
    vec3 low = value / 12.92;
    vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
    return mix(low, high, step(vec3(0.04045), value));
  }

  void main() {
    vec2 texel = 1.0 / max(uSourceSize, vec2(1.0));
    vec2 pixel = vUv * uSourceSize - 0.5;
    vec2 base = (floor(pixel) + 0.5) * texel;
    vec2 phase = fract(pixel);

    vec3 p00 = source(base, vUv);
    vec3 p10 = source(base + vec2(texel.x, 0.0), vUv);
    vec3 p01 = source(base + vec2(0.0, texel.y), vUv);
    vec3 p11 = source(base + texel, vUv);
    vec3 bilinear = mix(mix(p00, p10, phase.x), mix(p01, p11, phase.x), phase.y);

    // Edge-aware weights reduce color bleeding across strong compressed-video edges.
    float referenceLuma = localisLuma(bilinear);
    vec4 weights = vec4(
      (1.0 - phase.x) * (1.0 - phase.y),
      phase.x * (1.0 - phase.y),
      (1.0 - phase.x) * phase.y,
      phase.x * phase.y
    );
    vec4 edge = vec4(
      abs(localisLuma(p00) - referenceLuma),
      abs(localisLuma(p10) - referenceLuma),
      abs(localisLuma(p01) - referenceLuma),
      abs(localisLuma(p11) - referenceLuma)
    );
    weights /= 1.0 + edge * mix(2.5, 6.0, uQualityTaps);
    vec3 reconstructed = (p00 * weights.x + p10 * weights.y + p01 * weights.z + p11 * weights.w)
      / max(dot(weights, vec4(1.0)), 0.0001);

    vec3 north = source(vUv - vec2(0.0, texel.y), vUv);
    vec3 south = source(vUv + vec2(0.0, texel.y), vUv);
    vec3 west = source(vUv - vec2(texel.x, 0.0), vUv);
    vec3 east = source(vUv + vec2(texel.x, 0.0), vUv);
    vec3 localMin = min(reconstructed, min(min(north, south), min(west, east)));
    vec3 localMax = max(reconstructed, max(max(north, south), max(west, east)));
    vec3 blur = (north + south + west + east) * 0.25;

    if (uQualityTaps > 0.5) {
      vec3 nw = source(vUv - texel, vUv);
      vec3 ne = source(vUv + vec2(texel.x, -texel.y), vUv);
      vec3 sw = source(vUv + vec2(-texel.x, texel.y), vUv);
      vec3 se = source(vUv + texel, vUv);
      localMin = min(localMin, min(min(nw, ne), min(sw, se)));
      localMax = max(localMax, max(max(nw, ne), max(sw, se)));
      blur = mix(blur, (north + south + west + east + nw + ne + sw + se) * 0.125, 0.35);
    }

    float contrast = localisLuma(localMax) - localisLuma(localMin);
    float adaptive = mix(0.55, 1.0, smoothstep(0.02, 0.24, contrast));
    vec3 sharpened = reconstructed + (reconstructed - blur) * uSharpness * adaptive;
    vec3 margin = vec3(mix(0.005, 0.018, smoothstep(0.05, 0.3, contrast)));
    vec3 encoded = clamp(sharpened, localMin - margin, localMax + margin);
    gl_FragColor = vec4(srgbToLinear(clamp(encoded, 0.0, 1.0)), 1.0);
  }
`;

function stereoUniform(stereo: StereoLayout) {
  return stereo === 'sbs' ? 1 : stereo === 'tb' ? 2 : 0;
}

export class VideoSuperResolutionPass {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly quad: THREE.Mesh;
  private target?: THREE.WebGLRenderTarget;
  private dirty = true;
  private disposed = false;
  private planValue: SuperResolutionPlan = planSuperResolution(0, 0, 'off');
  private renderCountValue = 0;
  private lastRenderMsValue?: number;
  private contextLostValue = false;

  constructor(private readonly inputTexture: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: inputTexture },
        uSourceSize: { value: new THREE.Vector2(1, 1) },
        uSharpness: { value: 0.2 },
        uQualityTaps: { value: 0 },
        uStereoMode: { value: 0 },
        uWrapX: { value: 0 },
      },
      vertexShader,
      fragmentShader: spatialSuperResolutionFragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.Mesh(this.geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  configure(
    renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    requestedMode: SuperResolutionMode,
    stereo: StereoLayout,
    projection: Projection,
  ) {
    if (this.disposed) return;
    const next = planSuperResolution(width, height, requestedMode, renderer.capabilities.maxTextureSize, DEFAULT_MAX_PIXELS, stereo);
    const inputColorSpace = next.activeMode === 'off' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (this.inputTexture.colorSpace !== inputColorSpace) {
      this.inputTexture.colorSpace = inputColorSpace;
      this.inputTexture.needsUpdate = true;
    }
    const targetChanged = next.activeMode !== 'off'
      && (!this.target || this.target.width !== next.outputWidth || this.target.height !== next.outputHeight);
    this.planValue = next;
    this.material.uniforms.uSourceSize.value.set(Math.max(1, width), Math.max(1, height));
    this.material.uniforms.uSharpness.value = next.sharpness;
    this.material.uniforms.uQualityTaps.value = next.qualityTaps ? 1 : 0;
    this.material.uniforms.uStereoMode.value = stereoUniform(stereo);
    this.material.uniforms.uWrapX.value = projection === 'equirect360' ? 1 : 0;
    if (next.activeMode === 'off') {
      this.target?.dispose();
      this.target = undefined;
    } else if (targetChanged) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(next.outputWidth, next.outputHeight, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
      });
      // The pass writes linear RGB; downstream materials must not decode it again.
      this.target.texture.colorSpace = THREE.NoColorSpace;
      this.target.texture.name = 'Localis spatial super-resolution';
    }
    this.dirty = true;
  }

  get outputTexture() {
    return this.target?.texture ?? this.inputTexture;
  }

  get plan() {
    return this.planValue;
  }

  markFrame() {
    this.dirty = true;
  }

  setContextLost(lost: boolean) {
    this.contextLostValue = lost;
    if (!lost) this.dirty = true;
  }

  render(renderer: THREE.WebGLRenderer, force = false) {
    if (this.disposed || this.contextLostValue || !this.target || (!this.dirty && !force)) return false;
    const startedAt = performance.now();
    const previousTarget = renderer.getRenderTarget();
    const previousViewport = renderer.getViewport(new THREE.Vector4());
    const previousScissor = renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = renderer.getScissorTest();
    const previousAutoClear = renderer.autoClear;
    const previousXrEnabled = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.setViewport(0, 0, this.target.width, this.target.height);
      renderer.setScissorTest(false);
      renderer.clear(true, false, false);
      renderer.render(this.scene, this.camera);
      this.dirty = false;
      this.renderCountValue += 1;
      this.lastRenderMsValue = Math.round((performance.now() - startedAt) * 100) / 100;
      return true;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setViewport(previousViewport);
      renderer.setScissor(previousScissor);
      renderer.setScissorTest(previousScissorTest);
      renderer.autoClear = previousAutoClear;
      renderer.xr.enabled = previousXrEnabled;
    }
  }

  diagnostics(): SuperResolutionDiagnostics {
    return {
      ...this.planValue,
      renderCount: this.renderCountValue,
      lastRenderMs: this.lastRenderMsValue,
      contextLost: this.contextLostValue,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

interface InlineSuperResolutionOptions {
  mode: SuperResolutionMode;
  stereo: StereoLayout;
  projection: Projection;
  onDiagnostics?: (diagnostics: SuperResolutionDiagnostics) => void;
  onFailure?: (message: string) => void;
}

export class InlineVideoSuperResolution {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly videoTexture: THREE.VideoTexture;
  private readonly pass: VideoSuperResolutionPass;
  private readonly displayScene = new THREE.Scene();
  private readonly displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly displayGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly displayMaterial: THREE.MeshBasicMaterial;
  private readonly displayQuad: THREE.Mesh;
  private frameCallback?: number;
  private fallbackAnimationFrame?: number;
  private disposed = false;
  private active = true;
  private lastReportedAt = 0;
  private lastReportFingerprint = '';
  private fallbackNotified = false;
  private options: InlineSuperResolutionOptions;

  constructor(private readonly video: HTMLVideoElement, private readonly canvas: HTMLCanvasElement, options: InlineSuperResolutionOptions) {
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.videoTexture = new THREE.VideoTexture(video);
    // The reconstruction shader intentionally samples encoded video values and
    // converts only its final result to linear RGB. configure() switches this
    // to NoColorSpace while the pass is active.
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    this.pass = new VideoSuperResolutionPass(this.videoTexture);
    this.displayMaterial = new THREE.MeshBasicMaterial({ map: this.pass.outputTexture, toneMapped: false });
    this.displayQuad = new THREE.Mesh(this.displayGeometry, this.displayMaterial);
    this.displayQuad.frustumCulled = false;
    this.displayScene.add(this.displayQuad);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.video.addEventListener('loadedmetadata', this.onGeometryChange);
    this.video.addEventListener('resize', this.onGeometryChange);
    this.video.addEventListener('seeked', this.onNewFrame);
    this.video.addEventListener('playing', this.onPlaying);
    this.configure();
    this.scheduleVideoFrame();
    this.render(true);
  }

  private configure() {
    this.pass.configure(
      this.renderer,
      this.video.videoWidth,
      this.video.videoHeight,
      this.options.mode,
      this.options.stereo,
      this.options.projection,
    );
    const plan = this.pass.plan;
    if (plan.sourceWidth && plan.sourceHeight && this.options.mode !== 'off' && plan.activeMode === 'off') {
      this.active = false;
      if (!this.fallbackNotified) {
        this.fallbackNotified = true;
        queueMicrotask(() => this.options.onFailure?.(plan.reason || '当前视频无法安全启用实时超分，已保留原生播放。'));
      }
    }
    if (plan.outputWidth && plan.outputHeight) this.renderer.setSize(plan.outputWidth, plan.outputHeight, false);
    this.displayMaterial.map = this.pass.outputTexture;
    this.displayMaterial.needsUpdate = true;
    this.updateDataset();
  }

  update(options: InlineSuperResolutionOptions) {
    this.options = options;
    this.configure();
    this.render(true);
  }

  setActive(active: boolean) {
    this.active = active;
    if (active) {
      this.configure();
      this.render(true);
    } else {
      // Immersive mode owns its own renderer. Release the inline render target
      // so entering XR never keeps two high-resolution copies in GPU memory.
      this.pass.configure(
        this.renderer,
        this.video.videoWidth,
        this.video.videoHeight,
        'off',
        this.options.stereo,
        this.options.projection,
      );
      this.displayMaterial.map = this.pass.outputTexture;
      this.displayMaterial.needsUpdate = true;
      this.updateDataset();
    }
  }

  private updateDataset() {
    const diagnostics = this.pass.diagnostics();
    this.canvas.dataset.superResolution = diagnostics.activeMode;
    this.canvas.dataset.superResolutionRequested = diagnostics.requestedMode;
    this.canvas.dataset.sourceSize = `${diagnostics.sourceWidth}x${diagnostics.sourceHeight}`;
    this.canvas.dataset.outputSize = `${diagnostics.outputWidth}x${diagnostics.outputHeight}`;
    this.canvas.dataset.renderCount = String(diagnostics.renderCount);
    this.canvas.dataset.contextLost = String(diagnostics.contextLost);
    if (diagnostics.reason) this.canvas.dataset.superResolutionReason = diagnostics.reason;
    else delete this.canvas.dataset.superResolutionReason;
    const fingerprint = [
      diagnostics.requestedMode,
      diagnostics.activeMode,
      diagnostics.sourceWidth,
      diagnostics.sourceHeight,
      diagnostics.outputWidth,
      diagnostics.outputHeight,
      diagnostics.contextLost,
      diagnostics.reason,
    ].join('|');
    const now = performance.now();
    if (fingerprint !== this.lastReportFingerprint || now - this.lastReportedAt >= 1_000) {
      this.lastReportFingerprint = fingerprint;
      this.lastReportedAt = now;
      this.options.onDiagnostics?.(diagnostics);
    }
  }

  private render(force = false) {
    if (this.disposed || !this.active || !this.video.videoWidth || !this.video.videoHeight) return;
    this.pass.render(this.renderer, force);
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.canvas.width, this.canvas.height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.displayScene, this.displayCamera);
    this.updateDataset();
  }

  private onGeometryChange = () => {
    this.configure();
    this.pass.markFrame();
    this.render(true);
  };

  private onNewFrame = () => {
    this.pass.markFrame();
    this.render();
  };

  private onPlaying = () => {
    if (!('requestVideoFrameCallback' in this.video)) this.scheduleFallbackFrame();
  };

  private scheduleVideoFrame() {
    if (!('requestVideoFrameCallback' in this.video) || this.disposed) return;
    this.frameCallback = this.video.requestVideoFrameCallback(() => {
      this.onNewFrame();
      this.scheduleVideoFrame();
    });
  }

  private scheduleFallbackFrame() {
    if (this.disposed || this.video.paused || 'requestVideoFrameCallback' in this.video) return;
    this.fallbackAnimationFrame = requestAnimationFrame(() => {
      this.onNewFrame();
      this.scheduleFallbackFrame();
    });
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.pass.setContextLost(true);
    this.updateDataset();
    this.options.onFailure?.('GPU 上下文已中断，已恢复为原生视频画面。');
  };

  private onContextRestored = () => {
    this.pass.setContextLost(false);
    this.configure();
    this.render(true);
  };

  diagnostics() {
    return this.pass.diagnostics();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameCallback !== undefined && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.frameCallback);
    if (this.fallbackAnimationFrame !== undefined) cancelAnimationFrame(this.fallbackAnimationFrame);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.video.removeEventListener('loadedmetadata', this.onGeometryChange);
    this.video.removeEventListener('resize', this.onGeometryChange);
    this.video.removeEventListener('seeked', this.onNewFrame);
    this.video.removeEventListener('playing', this.onPlaying);
    this.pass.dispose();
    this.displayGeometry.dispose();
    this.displayMaterial.dispose();
    this.videoTexture.dispose();
    this.renderer.dispose();
  }
}
