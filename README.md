# Localis

Localis 是一个运行在电脑上的私有局域网媒体站。Vision Pro、Quest 和 PICO 端不安装任何程序，只用头显自带浏览器打开电脑给出的局域网网址，即可浏览和播放电脑里的视频、音频、VR180 与 360° 视频。

媒体文件不会上传到云端。普通文件通过 HTTP Range 直接读取；浏览器不支持的容器或编码由电脑实时转换为 H.264/AAC fMP4 HLS。WebXR 使用同一段视频纹理渲染平面、VR180、VR360、SBS/TB 和左右眼顺序。可选的 Localis 空间超分完全在访问设备的 GPU 上实时运行。

```text
电脑文件夹 ──扫描/ffprobe──> Localis 媒体库
                                  │
                 ┌────────────────┴───────────────┐
                 │ 可直接播放                     │ 不兼容
                 ▼                                ▼
            Range 原文件                    FFmpeg 实时 HLS
                 └────────────────┬───────────────┘
                                  ▼
                Vision Pro / Quest / PICO 浏览器
                    普通网页播放或 WebXR 沉浸播放
```

## 已实现

- 递归扫描 MP4、MOV、MKV、WebM、AVI、WMV、TS/M2TS、MPG/MPEG、VOB、3GP、MXF 等视频，以及 MP3、M4A、AAC、FLAC、ALAC、WAV、OGG、OPUS、AIFF、AC3/EAC3、DTS 等音频。
- Range 直放，支持固定、开放尾部和 suffix Range、`HEAD`、`If-Range`、`416`。
- 三段式兼容路径：原文件直放、无损 HLS remux、H.264/AAC 实时转码。
- 启动时真实探测 NVENC、Media Foundation、libx264；相同转码任务 single-flight，失败自动回退，输出按源版本缓存并以 LRU 容量上限清理。
- 外挂 SRT/VTT/ASS/SSA 与内封文本字幕统一转换成 WebVTT。
- VR180、VR360、平面，Mono/SBS/TB、LR/RL，并可在播放器中手动覆盖识别结果。
- 自研 WebGL 空间超分：边缘感知重建 + 对比度自适应锐化，普通网页播放器和 WebXR 使用同一套着色器，支持自动、高画质、仅锐化和关闭。
- WebXR 内的空间播放/暂停、前后 10 秒、退出和字幕面板，兼容 transient-pointer 与控制器射线的 `select` 事件。
- 六位配对码、HMAC 签名 HttpOnly Cookie、尝试限速、Host/Origin 检查、路径隐藏和 HLS 文件名白名单。
- 播放进度、搜索、最近播放、媒体文件夹管理、海报与设备诊断；Windows 电脑端可直接点击带图标的按钮打开原生文件夹选择窗口。
- 公网可信证书 + 私有 LAN DNS 的零安装 HTTPS 方案；证书私钥只保存在电脑上。

## 运行要求

- Windows 11 电脑（本版本的完整发布验收环境）。macOS/Linux 服务端代码和文件夹选择降级路径已实现，但尚未完成同等级真机回归。
- Node.js 22.13 或更高版本。
- FFmpeg 与 ffprobe 在 `PATH` 中。Windows 可执行：

```powershell
winget install Gyan.FFmpeg
```

首次安装和生成自带测试媒体：

```powershell
npm install
npm run fixtures
```

## 最快启动

开发模式：

```powershell
$env:LOCALIS_MEDIA_DIRS = 'D:\Videos'
npm run local
```

生产模式（不设置媒体目录时会加载自带样本，启动后可在电脑网页中点“添加媒体文件夹”）：

```powershell
npm run build
npm run start:local
```

也可以在启动前直接指定目录：

```powershell
$env:LOCALIS_MEDIA_DIRS = 'D:\Videos'
npm run start:local
```

终端会显示电脑地址、头显地址、实际选中的编码器和本次启动的六位配对码。例如：

```text
电脑：http://localhost:8080
头显：http://192.168.1.20:8080
配对码：123456（本次启动有效）
```

电脑和头显必须位于同一局域网；访客 Wi-Fi、AP isolation、VPN 或 Windows 防火墙可能阻断访问。首次运行时请允许 Node.js 通过 Windows“专用网络”防火墙。

裸 HTTP 可以完成普通视频/音频播放，但局域网地址上的 WebXR 必须使用浏览器信任的 HTTPS。`localhost` 在桌面浏览器中属于特殊安全上下文，不能代表头显的 LAN HTTP 地址也能进入 WebXR。

## 添加本地文件夹

在运行 Localis 的电脑上打开 `http://localhost:8080`，点击右上角带文件夹图标的“添加媒体文件夹”，再点“打开本地文件夹”。Windows 会显示原生文件夹选择窗口；选中后 Localis 自动保存目录并重新扫描。手动输入完整路径仍保留为降级入口。

文件夹管理 API 只接受 loopback 请求。因此 Vision Pro、手机、Quest 和 PICO 访问局域网地址时不会看到文件夹按钮，也不能让电脑弹窗或修改服务器目录；这些设备只负责浏览和播放。

## 实时空间超分

播放器的“实时超分”设置保存在当前浏览器设备中，不写入影片元数据：

| 模式 | 行为 |
| --- | --- |
| 自动（推荐） | 低于单眼 1080p 时通常放大 1.5×，到 1440p 附近使用 1.3×，高分辨率源自动转为轻量锐化 |
| 高画质 | 尽量使用 1.5× 边缘感知重建，并受 GPU 最大纹理与 1200 万输出像素预算约束 |
| 仅锐化 | 保持源分辨率，只做对比度自适应锐化 |
| 关闭 | 恢复浏览器原生视频画面与原生控制条 |

算法是 Localis 自研的单帧空间重建，不是神经网络，也不会伪称恢复源文件中不存在的真实细节。SBS/TB 在各眼纹理边界内采样，360° 水平方向在当前眼区域内循环。源视频或目标纹理超过安全预算、WebGL 初始化失败或 GPU context 丢失时会回退到原生播放器。进入 WebXR 时会先释放普通网页播放器的超分纹理，避免在 GPU 中保留双份高分辨率目标。

## Vision Pro 零安装 HTTPS

要同时满足“Vision Pro 不安装 App、不安装证书、只访问网址”和 WebXR 的 HTTPS 要求，需要一个自己控制的公共域名。Localis 会申请受公共浏览器信任的通配符证书，并让该域名只解析到电脑的私有局域网 IP；视频仍然直接走 LAN，不经过 Cloudflare 或其他云服务器。

当前脚本支持 Cloudflare DNS：

1. 准备一个由 Cloudflare 托管的公共域名，例如 `lan.example.com`。
2. 创建只对该 Zone 具有 `DNS:Edit` 权限的 API Token；不要使用全局 API Key。
3. 在 PowerShell 中设置变量并先使用 Let’s Encrypt staging 验证：

```powershell
$env:LOCALIS_BASE_DOMAIN = 'lan.example.com'
$env:CLOUDFLARE_ZONE_ID = '你的 Zone ID'
$env:CLOUDFLARE_API_TOKEN = '最小权限 Token'
$env:ACME_EMAIL = 'you@example.com'
$env:LOCALIS_ACME_STAGING = '1'
npm run tls:provision
```

4. staging 成功后移除测试开关，申请正式证书并重启服务：

```powershell
Remove-Item Env:LOCALIS_ACME_STAGING -ErrorAction SilentlyContinue
npm run tls:provision
npm run start:local
```

脚本会给出类似下面的地址：

```text
https://192-168-1-20.<随机服务器ID>.lan.example.com:8080
```

通配符证书覆盖 DHCP 变化后的不同 IP 前缀。账户密钥、证书私钥和缓存默认写入系统应用数据目录（Windows 为 `%LOCALAPPDATA%\Localis`，macOS 为 `~/Library/Application Support/Localis`，Linux 为 `$XDG_DATA_HOME/localis`），而不是代码仓库。建议每月运行一次 `npm run tls:provision`；证书剩余超过 30 天时只刷新 DNS，不重复签发。

部分路由器会把“公共 DNS 返回私有 IP”视为 DNS rebinding 并拦截。如果可信地址无法解析，检查路由器的 DNS rebinding protection/私人域名白名单，或让头显使用不会改写该记录的 DNS。完全离线的首次使用、头显零证书配置和 WebXR 三者无法同时保证：公共证书签发与首次 DNS 解析至少需要联网，媒体传输本身不需要公网。

## 播放策略与边界

| 输入 | 默认路径 |
| --- | --- |
| 浏览器可解码的 MP4/WebM/音频 | Range 原文件直放 |
| H.264/AAC 位于 MKV/TS 等容器 | fMP4 HLS remux，不重编码 |
| H.264 + 不兼容音频 | 复制视频，仅转 AAC 音频 |
| MPEG-4 Part 2、VC-1 等不兼容视频 | H.264/AAC 实时 HLS |
| SRT/VTT/ASS/SSA 文本字幕 | WebVTT |

“所有种类”在浏览器产品里只能通过兼容转码尽量覆盖，不可能绝对保证。首版明确不处理 DRM、蓝光菜单/加密光盘、PGS/VobSub 位图字幕 OCR、专有加密容器；Apple 空间视频应优先尝试原文件播放。4K/6K/8K 和 HDR 的最终效果取决于电脑编码能力、Wi-Fi 吞吐、头显解码器和最大纹理尺寸。

GitHub 仓库只托管 Localis 源代码，不托管或中转你的媒体，也不是可直接部署到云端的媒体服务。`.openai/hosting.json` 是现有前端构建脚手架；完整 Localis 必须在能访问本机媒体和 FFmpeg 的电脑上运行。

## 常用配置

可复制 [.env.example](./.env.example) 查看完整示例。Vinext/tsx 不会自动读取这个文件；请在 shell、服务管理器或启动脚本中设置环境变量。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LOCALIS_MEDIA_DIRS` | 多个媒体根目录；使用系统路径分隔符连接 | 自带 `sample-media` |
| `LOCALIS_DATA_DIR` | 配置、配对密钥、TLS 与缓存的私有目录 | 系统应用数据目录 |
| `LOCALIS_PORT` | 对设备暴露的端口 | `8080` |
| `LOCALIS_PAIR_CODE` | 固定六位码；不设则每次启动随机 | 随机 |
| `LOCALIS_MAX_TRANSCODES` | 同时实时转码数 | `1` |
| `LOCALIS_CACHE_GB` | HLS 缓存容量上限，超限按最久未使用清理 | `20` |
| `LOCALIS_ENCODER` | 强制 `h264_nvenc`、`h264_mf` 或 `libx264` | 实际探测 |
| `LOCALIS_TLS_CERT` / `LOCALIS_TLS_KEY` | 自备证书链与私钥 | 自动读取数据目录下的 `tls` |
| `LOCALIS_ALLOWED_HOSTS` | 额外允许的 Host，逗号分隔 | 本机/LAN/可信域名 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 可执行文件路径 | `ffmpeg` / `ffprobe` |
| `LOCALIS_AUTH_DISABLED=1` | 仅用于本机开发，跳过配对 | 关闭 |

## 验证

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

当前自动化套件为 7 个文件、30 项测试，会现场生成确定性媒体，验证扫描与路径隐藏、原生文件夹选择协议、配对签名和限速、Range 字节一致性、字幕、超分预算与眼间边界、真实 HLS remux/transcode，并用 ffprobe 断言输出为 H.264/yuv420p + AAC。另有生产构建上的真实 Chromium 播放与 WebGL shader 编译测试。详细记录见 [测试报告](./docs/TEST_REPORT.md)，真机步骤见 [头显验收清单](./docs/HEADSET_ACCEPTANCE.md)。

## 许可提醒

项目本身尚未附加开源许可证，当前 GitHub 仓库应保持私有。依赖说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。FFmpeg 的许可取决于采用的构建；Windows 上常见的 `full_build` 若包含 libx264，通常适用 GPL。发布二进制产品或公开源码前需要根据所分发的 FFmpeg 构建完成许可证与源代码义务评估。
