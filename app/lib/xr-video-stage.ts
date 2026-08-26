import * as THREE from 'three';
import type { EyeOrder, Projection, StereoLayout } from '@/server/types';

export interface XrVideoOptions {
  projection: Projection;
  stereo: StereoLayout;
  eyeOrder: EyeOrder;
  yawOffset: number;
}

export interface XrDiagnostics {
  secureContext: boolean;
  webXrAvailable: boolean;
  xrSessionActive: boolean;
  graphicsApi: 'webgl' | 'webgl2';
  videoTextureColorSpace: 'srgb';
  /** WebGL/WebXR does not expose proof of an HDR presentation signal. */
  hdrPresentationVerified: false;
  maxTextureSize: number;
  videoWidth: number;
  videoHeight: number;
  droppedFrames?: number;
  totalFrames?: number;
}

type ControlAction = { mesh: THREE.Mesh; run: () => void };

export function stereoSamplingBounds(stereo: StereoLayout, effectiveEye: 0 | 1, textureWidth: number, textureHeight: number) {
  if (stereo === 'sbs') {
    const halfTexel = 0.5 / Math.max(2, textureWidth);
    const minimum = effectiveEye === 0 ? halfTexel : 0.5 + halfTexel;
    const maximum = effectiveEye === 0 ? 0.5 - halfTexel : 1 - halfTexel;
    return { minimum, span: Math.max(0, maximum - minimum) };
  }
  const halfTexel = 0.5 / Math.max(2, textureHeight);
  // THREE.VideoTexture uses flipY=true. In a conventional top/bottom LR file,
  // the left eye occupies the source image's top half, which is the upper half
  // of WebGL UV space after the texture flip.
  const textureEye = effectiveEye === 0 ? 1 : 0;
  const minimum = textureEye === 0 ? halfTexel : 0.5 + halfTexel;
  const maximum = textureEye === 0 ? 0.5 - halfTexel : 1 - halfTexel;
  return { minimum, span: Math.max(0, maximum - minimum) };
}

function labelTexture(label: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 180;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'rgba(21, 23, 27, .92)';
  context.beginPath();
  context.roundRect(8, 8, 496, 164, 28);
  context.fill();
  context.strokeStyle = 'rgba(255,255,255,.22)';
  context.lineWidth = 3;
  context.stroke();
  context.fillStyle = '#f4f2ee';
  context.font = '600 54px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, 256, 91);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function applyStereoUv(
  geometry: THREE.BufferGeometry,
  stereo: StereoLayout,
  eye: 0 | 1,
  eyeOrder: EyeOrder,
  textureWidth: number,
  textureHeight: number,
) {
  if (stereo === 'mono') return;
  const effectiveEye = eyeOrder === 'lr' ? eye : eye === 0 ? 1 : 0;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let index = 0; index < uv.count; index += 1) {
    if (stereo === 'sbs') {
      const bounds = stereoSamplingBounds(stereo, effectiveEye, textureWidth, textureHeight);
      uv.setX(index, bounds.minimum + uv.getX(index) * bounds.span);
    } else {
      const bounds = stereoSamplingBounds(stereo, effectiveEye, textureWidth, textureHeight);
      uv.setY(index, bounds.minimum + uv.getY(index) * bounds.span);
    }
  }
  uv.needsUpdate = true;
}

export class XrVideoStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);
  private readonly texture: THREE.VideoTexture;
  private readonly mediaMeshes: THREE.Mesh[] = [];
  private readonly controls: ControlAction[] = [];
  private readonly captionCanvas = document.createElement('canvas');
  private readonly captionTexture: THREE.CanvasTexture;
  private readonly captionMesh: THREE.Mesh;
  private captionText = '';
  private readonly capturedControls = new Map<XRInputSource, ControlAction | null>();
  private readonly viewerPosition = new THREE.Vector3();
  private readonly viewerDirection = new THREE.Vector3();
  private readonly captionTarget = new THREE.Vector3();
  private readonly captionLookTarget = new THREE.Object3D();
  private session?: XRSession;
  private entering = false;
  private disposed = false;
  private shouldPlayInXr = false;
  private options: XrVideoOptions;

  constructor(
    private readonly video: HTMLVideoElement,
    options: XrVideoOptions,
    private readonly onSessionStateChange?: (active: boolean) => void,
  ) {
    this.options = options;
    this.scene.background = new THREE.Color(0x050608);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.className = 'xr-render-surface';
    this.renderer.domElement.style.display = 'none';
    document.body.appendChild(this.renderer.domElement);

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.camera.layers.enable(1);
    this.buildMediaMeshes();
    this.buildControls();
    this.captionCanvas.width = 1400;
    this.captionCanvas.height = 220;
    this.captionTexture = new THREE.CanvasTexture(this.captionCanvas);
    this.captionTexture.colorSpace = THREE.SRGBColorSpace;
    this.captionMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.8, 0.6),
      new THREE.MeshBasicMaterial({ map: this.captionTexture, transparent: true, toneMapped: false }),
    );
    this.captionMesh.position.set(0, -0.75, -3.2);
    this.captionMesh.visible = false;
    this.scene.add(this.captionMesh);
    this.video.addEventListener('loadedmetadata', this.onVideoGeometryChange);
    this.video.addEventListener('resize', this.onVideoGeometryChange);
    this.video.addEventListener('ended', this.onVideoEnded);
  }

  update(options: XrVideoOptions) {
    if (this.disposed) return;
    this.options = options;
    this.buildMediaMeshes();
  }

  private createGeometry() {
    let aspect = this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
    if (this.options.stereo === 'sbs') aspect /= 2;
    if (this.options.stereo === 'tb') aspect *= 2;
    if (this.options.projection === 'flat') return new THREE.PlaneGeometry(4.8 * aspect, 4.8);
    const geometry = this.options.projection === 'equirect180'
      ? new THREE.SphereGeometry(10, 72, 40, Math.PI, Math.PI)
      : new THREE.SphereGeometry(10, 72, 40);
    geometry.scale(-1, 1, 1);
    // The partial sphere already covers the viewer's forward -Z hemisphere.
    // Rotate only a full sphere to place its seam behind the initial view.
    if (this.options.projection === 'equirect360') geometry.rotateY(-Math.PI / 2);
    return geometry;
  }

  private onVideoGeometryChange = () => {
    if (this.disposed) return;
    this.buildMediaMeshes();
  };
  private onVideoEnded = () => { this.shouldPlayInXr = false; };

  private buildMediaMeshes() {
    for (const mesh of this.mediaMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.mediaMeshes.length = 0;

    const eyes: Array<0 | 1> = this.options.stereo === 'mono' ? [0] : [0, 1];
    const textureWidth = this.video.videoWidth || 2;
    const textureHeight = this.video.videoHeight || 2;
    for (const eye of eyes) {
      const geometry = this.createGeometry();
      applyStereoUv(geometry, this.options.stereo, eye, this.options.eyeOrder, textureWidth, textureHeight);
      const material = new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.FrontSide, toneMapped: false });
      const mesh = new THREE.Mesh(geometry, material);
      if (this.options.projection === 'flat') mesh.position.set(0, 0, -5);
      mesh.rotation.y = this.options.yawOffset;
      mesh.layers.set(this.options.stereo === 'mono' ? 0 : eye === 0 ? 1 : 2);
      this.scene.add(mesh);
      this.mediaMeshes.push(mesh);
    }
  }

  private buildControls() {
    const group = new THREE.Group();
    group.position.set(0, -1.4, -2.7);
    const actions: Array<[string, () => void]> = [
      ['−10', () => { this.video.currentTime = Math.max(0, this.video.currentTime - 10); }],
      ['播放 / 暂停', () => {
        if (this.video.paused) {
          this.shouldPlayInXr = true;
          void this.video.play();
        } else {
          this.shouldPlayInXr = false;
          this.video.pause();
        }
      }],
      ['+10', () => { this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10); }],
      ['退出', () => { void this.session?.end(); }],
    ];
    actions.forEach(([label, run], index) => {
      const width = index === 1 ? 1.25 : 0.7;
      const material = new THREE.MeshBasicMaterial({ map: labelTexture(label), transparent: true, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.34), material);
      mesh.position.x = [-1.35, -0.35, 0.75, 1.55][index];
      group.add(mesh);
      this.controls.push({ mesh, run });
    });
    this.scene.add(group);
  }

  private hitControl(event: XRInputSourceEvent) {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) return undefined;
    const pose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
    if (!pose) return undefined;
    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(matrix);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(matrix);
    const hit = raycaster.intersectObjects(this.controls.map((control) => control.mesh), false)[0];
    return this.controls.find((control) => control.mesh === hit?.object);
  }

  private onSelectStart = (event: XRInputSourceEvent) => {
    this.capturedControls.set(event.inputSource, this.hitControl(event) ?? null);
  };

  private onSelect = (event: XRInputSourceEvent) => {
    const hadStart = this.capturedControls.has(event.inputSource);
    const control = hadStart ? this.capturedControls.get(event.inputSource) : this.hitControl(event);
    this.capturedControls.delete(event.inputSource);
    control?.run();
  };

  private onSelectEnd = (event: XRInputSourceEvent) => this.capturedControls.delete(event.inputSource);

  private onVisibilityChange = () => {
    if (this.session?.visibilityState === 'visible' && this.shouldPlayInXr && this.video.paused && !this.video.ended) {
      void this.video.play();
    }
  };

  private onSessionEnd = (event: Event) => this.cleanupSession(event.target as XRSession);

  private cleanupSession(session: XRSession) {
    session.removeEventListener('selectstart', this.onSelectStart);
    session.removeEventListener('select', this.onSelect);
    session.removeEventListener('selectend', this.onSelectEnd);
    session.removeEventListener('visibilitychange', this.onVisibilityChange);
    session.removeEventListener('end', this.onSessionEnd);
    this.capturedControls.clear();
    if (this.session === session) this.session = undefined;
    this.renderer.domElement.style.display = 'none';
    this.renderer.setAnimationLoop(null);
    if (!this.disposed) {
      this.buildMediaMeshes();
    }
    this.onSessionStateChange?.(false);
  }

  private updateCaptions() {
    const track = [...this.video.textTracks].find((candidate) => candidate.mode !== 'disabled');
    const text = track?.activeCues
      ? [...track.activeCues].map((cue) => (cue as VTTCue).text.replace(/<[^>]*>/g, '')).join('\n')
      : '';
    if (text === this.captionText) return;
    this.captionText = text;
    this.captionMesh.visible = Boolean(text);
    const context = this.captionCanvas.getContext('2d')!;
    context.clearRect(0, 0, this.captionCanvas.width, this.captionCanvas.height);
    if (text) {
      context.fillStyle = 'rgba(0,0,0,.72)';
      context.beginPath();
      context.roundRect(20, 20, this.captionCanvas.width - 40, this.captionCanvas.height - 40, 34);
      context.fill();
      context.fillStyle = '#fff';
      context.font = '600 58px system-ui, "PingFang SC", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const lines: string[] = [];
      for (const paragraph of text.split('\n')) {
        let line = '';
        for (const character of paragraph) {
          if (context.measureText(line + character).width > this.captionCanvas.width - 110 && line) {
            lines.push(line);
            line = character;
            if (lines.length === 2) break;
          } else line += character;
        }
        if (lines.length < 2 && line) lines.push(line);
        if (lines.length === 2) break;
      }
      lines.forEach((line, index) => context.fillText(line, this.captionCanvas.width / 2, lines.length === 1 ? 110 : 77 + index * 70, this.captionCanvas.width - 90));
    }
    this.captionTexture.needsUpdate = true;
  }

  async isSupported() {
    return Boolean(!this.disposed && navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'));
  }

  async enter() {
    if (this.disposed) throw new Error('播放器已关闭。');
    if (!window.isSecureContext) throw new Error('WebXR 需要可信 HTTPS；局域网裸 HTTP 只能进行普通播放。');
    if (!navigator.xr) throw new Error('当前浏览器或设备不支持沉浸式 WebXR。');
    if (this.session) return;
    if (this.entering) throw new Error('正在进入沉浸模式，请稍候。');
    this.entering = true;
    const wasPaused = this.video.paused;
    let session: XRSession | undefined;
    try {
      // Both protected operations are invoked before the first await so Safari
      // sees the original click activation for each one.
      const sessionPromise = navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      const playbackPromise = this.video.play();
      const [sessionResult, playbackResult] = await Promise.allSettled([sessionPromise, playbackPromise]);
      if (sessionResult.status === 'rejected') throw sessionResult.reason;
      session = sessionResult.value;
      if (this.disposed) {
        await session.end().catch(() => undefined);
        throw new Error('播放器已关闭。');
      }
      if (playbackResult.status === 'rejected') {
        await session.end().catch(() => undefined);
        throw playbackResult.reason;
      }

      this.session = session;
      this.shouldPlayInXr = true;
      this.buildMediaMeshes();
      session.addEventListener('selectstart', this.onSelectStart);
      session.addEventListener('select', this.onSelect);
      session.addEventListener('selectend', this.onSelectEnd);
      session.addEventListener('visibilitychange', this.onVisibilityChange);
      session.addEventListener('end', this.onSessionEnd, { once: true });
      this.renderer.domElement.style.display = 'block';
      await this.renderer.xr.setSession(session);
      if (this.disposed) {
        await session.end().catch(() => undefined);
        throw new Error('播放器已关闭。');
      }
      this.onSessionStateChange?.(true);
      this.renderer.setAnimationLoop(() => {
        this.updateCaptions();
        const xrCamera = this.renderer.xr.getCamera();
        xrCamera.getWorldPosition(this.viewerPosition);
        xrCamera.getWorldDirection(this.viewerDirection);
        this.viewerDirection.y = 0;
        if (this.viewerDirection.lengthSq() > 0.001) this.viewerDirection.normalize();
        this.captionTarget.copy(this.viewerPosition).addScaledVector(this.viewerDirection, 3.2);
        this.captionTarget.y = this.viewerPosition.y - 0.75;
        this.captionMesh.position.lerp(this.captionTarget, 0.12);
        this.captionLookTarget.position.copy(this.captionMesh.position);
        this.captionLookTarget.lookAt(this.viewerPosition.x, this.captionMesh.position.y, this.viewerPosition.z);
        this.captionMesh.quaternion.slerp(this.captionLookTarget.quaternion, 0.12);
        this.renderer.render(this.scene, this.camera);
      });
    } catch (cause) {
      if (session) {
        this.cleanupSession(session);
        await session.end().catch(() => undefined);
      }
      if (wasPaused) this.video.pause();
      throw cause;
    } finally {
      this.entering = false;
    }
  }

  diagnostics(): XrDiagnostics {
    const quality = this.video.getVideoPlaybackQuality?.();
    const context = this.renderer.getContext();
    return {
      secureContext: window.isSecureContext,
      webXrAvailable: Boolean(navigator.xr),
      xrSessionActive: Boolean(this.session),
      graphicsApi: typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext
        ? 'webgl2'
        : 'webgl',
      videoTextureColorSpace: 'srgb',
      hdrPresentationVerified: false,
      maxTextureSize: context.getParameter(context.MAX_TEXTURE_SIZE) as number,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      droppedFrames: quality?.droppedVideoFrames,
      totalFrames: quality?.totalVideoFrames,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    if (session) {
      this.cleanupSession(session);
      void session.end();
    }
    this.renderer.setAnimationLoop(null);
    this.video.removeEventListener('loadedmetadata', this.onVideoGeometryChange);
    this.video.removeEventListener('resize', this.onVideoGeometryChange);
    this.video.removeEventListener('ended', this.onVideoEnded);
    for (const mesh of this.mediaMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const control of this.controls) {
      control.mesh.geometry.dispose();
      const material = control.mesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.captionMesh.geometry.dispose();
    (this.captionMesh.material as THREE.Material).dispose();
    this.captionTexture.dispose();
    this.texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
