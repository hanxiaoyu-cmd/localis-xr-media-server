# Localis

Localis 是运行在电脑上的私有局域网媒体站。Vision Pro、Quest 和 PICO 不需要安装任何程序，只需用头显自带浏览器打开电脑显示的局域网网址，即可播放本地视频、音频、VR180 与 VR360。

普通文件通过 HTTP Range 直读；浏览器不兼容的媒体由电脑上的 FFmpeg 生成 H.264/AAC HLS。所有超分档位使用覆盖整部影片的可跳转 VOD 时间线，浏览器拖到哪里，电脑就优先生成并缓存哪里的 4 秒 H.264/AAC 分片，不再要求长片从 00:00 顺序算到目标位置。头显只解码最终视频，不运行 WebGL 超分画布，因此不会再出现“画面卡住但字幕仍在动”的设备端超分故障。

```text
电脑文件夹 ───────────────┐
                         ├─> Localis 媒体库 ─> Range / 电脑端 FFmpeg HLS ─> 头显浏览器
夸克/百度 ─> 电脑端桥接 ─┘                       │
                                                └─ 平面 / VR180 / VR360 / SBS / TB / WebXR
```

## 已实现

- 递归扫描 MP4、MOV、MKV、WebM、AVI、WMV、TS/M2TS、MPG/MPEG、VOB、3GP、MXF 等视频，以及 MP3、M4A、AAC、FLAC、ALAC、WAV、OGG、OPUS、AIFF、AC3/EAC3、DTS 等音频。
- Range 直放，支持固定、开放尾部和 suffix Range、`HEAD`、`If-Range` 与 `416`。
- 原文件直放、无损 HLS remux、仅转音频、H.264/AAC 完整转码四条兼容路径。
- 启动时真实探测 NVENC、Media Foundation、libx264；相同任务 single-flight，失败自动回退，输出按源版本、超分档位和 4 秒分片独立缓存。
- 电脑端四档空间超分：关闭、标准最多 1.25×、高最多 1.5×、极致最多 2×；Vision Pro/Quest/PICO 端完全不承担超分计算。
- SBS/TB 在电脑端按每只眼独立重建，避免眼间边界串色；360° 使用 FFmpeg `v360` 的环绕采样保持经度接缝连续。
- 外挂 SRT/VTT/ASS/SSA 与内封文本字幕统一转换成 WebVTT。
- VR180、VR360、平面，Mono/SBS/TB、LR/RL，并可手动覆盖识别结果。
- WebXR 内空间播放/暂停、前后 10 秒、退出和字幕面板。
- 电脑端可用原生文件夹选择窗口添加媒体；完整路径输入仍作为降级入口。
- 电脑端云盘工作台：百度在电脑上一次加密保存应用身份，之后只需扫码；夸克使用官方组件完成电脑浏览器 OAuth、关键词搜索和完整下载入库。
- 云盘凭据、百度 dlink 和夸克 FID 都不发送给头显；百度/WebDAV 由电脑代理或缓存，夸克只有完整下载并通过 ffprobe 的本地副本才会进入资料库。
- 六位配对码、HMAC 签名 HttpOnly Cookie、尝试限速、Host/Origin 检查、路径隐藏和 HLS 文件名白名单。
- 公网可信证书 + 私有 LAN DNS 的零安装 HTTPS 方案；证书私钥只保存在电脑上。

## 运行要求

- Windows 11 电脑（本版本完整验收环境）。macOS/Linux 服务端与文件夹选择降级路径已实现，但尚未完成同等级真机回归。
- Node.js 22.13 或更高版本。
- FFmpeg 与 ffprobe 在 `PATH` 中。Windows 可执行：

```powershell
winget install Gyan.FFmpeg
```

首次安装并生成自带测试媒体：

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

生产模式：

```powershell
npm run build
npm run start:local
```

不设置媒体目录时会加载自带样本，之后可在电脑页面中添加文件夹。终端会显示电脑地址、头显地址、实际编码器和本次启动的六位配对码，例如：

```text
电脑：http://localhost:8080
头显：http://192.168.1.20:8080
配对码：123456（本次启动有效）
```

电脑和头显必须处于同一局域网。访客 Wi-Fi、AP isolation、VPN 或 Windows 防火墙可能阻断访问；首次运行请允许 Node.js 通过 Windows“专用网络”防火墙。

裸 HTTP 可以播放普通视频和音频，但 LAN 地址上的 WebXR 需要浏览器信任的 HTTPS。桌面上的 `localhost` 是特殊安全上下文，不能证明头显访问 LAN HTTP 时也能进入 WebXR。

## 添加电脑文件夹

在运行 Localis 的电脑上打开 `http://localhost:8080`，点击带文件夹图标的“添加媒体文件夹”，再点“打开本地文件夹”。选择后会保存目录并重新扫描。手动输入完整路径仍保留为降级入口。

文件夹与云盘管理 API 只接受 loopback 请求。因此 Vision Pro、手机、Quest 和 PICO 不会看到这些管理按钮，也不能让电脑弹窗、修改媒体目录或读取云盘凭据。

## 电脑端超分档位

播放器默认使用“标准”档，选择保存在浏览器本地。所有非关闭档都会请求独立的电脑端 HLS 路径，例如 `/api/media/:id/hls/high/index.m3u8`。

| 档位 | 目标行为 | 额外放大预算 |
| --- | --- | --- |
| 关闭 | 可直放时读取原文件，否则仅做兼容 HLS | 不做超分 |
| 标准 | 1.25× spline16 + 轻量 CAS，日常推荐 | 长边 2560、500 万像素 |
| 高 | 1.5× spline36 + CAS | 长边 3840、900 万像素 |
| 极致 | 2× Lanczos + 较强 CAS | 长边 4096、1200 万像素 |

倍率和像素数是“最多放大多少”，不是强制输出尺寸。标准/高/极致不会把高分辨率原片反向缩小：源画面已达到档位预算时保持 1×，只做安全锐化；源尺寸或像素率本身超过 H.264 Level 5.2 时，该超分档明确返回不可用，并提示改用原片或 HEVC。当前引擎是 FFmpeg 的高质量空间缩放与对比度自适应锐化，不是神经网络，也不会伪称恢复源视频中不存在的真实细节。本机实测采用 CPU `zscale/CAS` 滤镜加 NVENC 编码；没有 NVENC 时会自动回退 Media Foundation 或 libx264。极致档会增加首播等待、缓存占用和电脑负载。

视频播放器使用统一绿色控制条，不依赖会因平台字体而变成 emoji 的字符图标。时间轴始终以原片完整时长为范围；跳到尚未缓存的位置时，Localis 直接从该时间点附近启动电脑端 FFmpeg，而不是等待前面的内容。界面分别显示当前 4 秒分片的生成进度、处理倍速和整片缓存覆盖率。WebXR 直接使用电脑生成的视频纹理；设备上没有额外超分 render target。切换档位时会恢复原播放位置和播放状态。

## 连接云盘

只能在电脑的 `localhost` 页面点击“连接云盘”。云盘文件不会经过 Localis 的 GitHub 或任何 Localis 云服务；数据路径是“网盘 → 当前电脑 → 当前局域网设备”。

### 夸克网盘

Localis 现在接入[夸克官方网盘 Skill/CLI](https://github.com/quark-clouddrive/quarkclouddrive_offical)，严格采用它公开的“电脑浏览器 OAuth → 关键词搜索 → 完整下载”契约：

1. 在电脑端点击“连接云盘 → 夸克网盘”。
2. 首次点击“安装夸克官方组件”。Localis 只在这次明确操作后从夸克官方 GitHub 仓库下载组件到系统应用数据目录，不把运行时提交到本仓库。
3. 点击“打开电脑浏览器授权”，在这台电脑完成夸克官方 OAuth；若官方流程返回手动授权地址，界面会显示链接和授权码输入框。
4. 输入关键词搜索视频或音频，选择结果，再点“下载到电脑并加入资料库”。
5. Localis 使用不透明选择 ID 隔离真实 FID，把下载写入受管暂存目录；只有唯一媒体文件完整落盘、路径校验和 ffprobe 全部成功后，才原子移动到持久资料库。Vision Pro/Quest/PICO 始终只读取这个电脑本地副本。

官方 CLI 不提供个人网盘目录树，也不提供可嵌入的 HTTP Range 流媒体接口，因此 Localis 不伪造“浏览整个云盘”或“边下边播”。当前官方支持矩阵要求 Windows WSL；本机 WSL 因 Windows hypervisor 组件未生效而无法启动，所以 Localis 同时提供 Windows 本机兼容模式。该模式已实际通过官方组件 1.0.14 安装、版本探测和未登录协议响应，但真实账号 OAuth/下载仍需用户凭据验收，界面会明确显示这项运行环境提示。

Localis 不抓取夸克 Cookie、不读取官方组件保存的 Token、不复制私有签名算法，也不使用 OpenList QuarkTV 当前通过第三方明文 HTTP 服务交换登录票据的链路。

已经自行评估并部署 OpenList 的高级用户仍可展开“高级兼容：我已有本机 OpenList”，使用标准 WebDAV 只读桥接：

1. 用户自行安装和维护 [OpenList](https://github.com/OpenListTeam/OpenList)，在其中挂载夸克。
2. OpenList 只监听 `127.0.0.1:5244`，不要直接暴露给局域网。
3. 创建 `localis-reader` 用户，只授予目标目录和 `WebDAV Read` 权限。
4. 将 OpenList 存储的“WebDAV 策略”设为“本机代理（Native Proxy）”。
5. 在折叠的高级入口中填写 `http://127.0.0.1:5244/dav/`、挂载路径（通常 `/Quark`）和只读账户。

Localis 会拒绝非 loopback 地址和 URL 内嵌账号密码，也绝不跟随 WebDAV 文件 GET 返回的 `302`。因此目录可能可以扫描，但若单个文件仍由 OpenList 重定向到上游地址，Localis 会在播放前明确报错；请检查“WebDAV 策略”是否为“本机代理”。有关夸克驱动的非官方性质与限制，参见 [OpenList 夸克驱动说明](https://doc.oplist.org/guide/drivers/quark.html) 和 [WebDAV 文档](https://doc.oplist.org/guide/advanced/webdav)。

### 百度网盘

百度设备码授权仍要求经过百度审核的开发者应用身份。Localis 现在把首次设置也放在电脑页面中：AppKey、SecretKey 和单层应用目录只在 localhost 提交一次并加密保存在系统应用数据目录；局域网设备看不到表单，也不能调用设置接口。之后日常使用就是：

1. 在电脑端点击“连接云盘 → 百度网盘”。
2. 首次使用填写百度开放平台应用信息并点“保存并显示二维码”；以后直接点“显示登录二维码”。
3. 使用百度网盘 App 扫码授权。
4. 授权完成后 Localis 自动扫描 `/apps/应用目录名`，媒体随即出现在资料库。

部署者也可以继续用环境变量锁定应用身份，此时网页只显示扫码入口，不能覆盖电脑环境配置：

```powershell
$env:LOCALIS_BAIDU_APP_KEY = '已审核应用的 AppKey'
$env:LOCALIS_BAIDU_SECRET_KEY = '已审核应用的 SecretKey'
$env:LOCALIS_BAIDU_APP_FOLDER = 'Localis'
npm run start:local
```

百度的设备码换取 Token 与后续刷新都要求 SecretKey，因此 Localis 不可能在没有开发者应用的情况下凭空提供二维码。面向公众发布时，共享 SecretKey 不能安全地编译进桌面程序；正式产品仍需发布者维护只负责换票/刷新的 HTTPS OAuth Broker，并完成百度公开应用审核。媒体列表、下载、Range、缓存、FFmpeg 转码和超分仍全部在用户电脑完成，不经过 Broker。详见[设备码授权文档](https://pan.baidu.com/union/doc/使用入门/接入授权/设备码模式授权/)、[创建应用](https://pan.baidu.com/union/doc/使用入门/创建应用/)与[权限和配额](https://pan.baidu.com/union/doc/使用入门/权限与配额/)。

Access Token、Refresh Token 与用于刷新它们的 SecretKey 会以 AES-256-GCM 密文保存到仓库外的数据目录；加密密钥同样只保存在该操作系统用户的数据目录并限制文件权限。浏览器、日志、媒体 URL 与 FFmpeg 命令行都不会收到这些值或百度 dlink。

仓库自动化会验证“无配置时安全禁用、服务器凭据永不出现在网页、二维码会话幂等恢复、设备码换票、分页、Range 与密文持久化”的完整协议模拟。没有发布者的已审核应用和真实账号授权时，不能诚实声称真实百度账号已通过端到端验收。

### 云盘播放行为

- 百度和 WebDAV 的可直接播放文件由电脑代理 HTTP Range；头显只访问 Localis URL。需要兼容转码或超分时，电脑先缓存完整源文件，再启动 FFmpeg。
- 夸克文件在电脑管理页主动下载；下载中不会出现在媒体库，完成并校验后作为持久本地文件播放。头显请求永远不会触发夸克上游下载。
- 夸克持久资料库同样遵守 `LOCALIS_CLOUD_CACHE_GB` 总容量边界，并额外保留 512 MiB 磁盘余量；达到上限时需要先在电脑上移走不再需要的文件。
- 云缓存默认是 50 GB 硬上限，并预留文件系统可用空间；下载前检查声明大小，下载时继续逐字节计数，无法安全腾出空间时返回 `507`，不会“先写爆磁盘再清理”。
- 百度/WebDAV 缓存清单与 LRU 时间持久化到数据目录；夸克崩溃残留的 `.part` 文件会在下次启动清理。夸克始终一次只下载一个文件；其他云缓存默认并行 1 个，可用 `LOCALIS_MAX_CLOUD_DOWNLOADS` 调到 2。
- 首版只读，不提供上传、删除、移动或分享操作。

## Vision Pro 零安装 HTTPS

要同时满足“Vision Pro 不安装 App、不安装证书、只访问网址”和 WebXR 的 HTTPS 要求，需要一个自己控制的公共域名。Localis 可申请公共浏览器信任的通配符证书，并让域名只解析到电脑的私有局域网 IP；视频仍直接走 LAN，不经过 Cloudflare 或其他云服务器。

当前脚本支持 Cloudflare DNS：

```powershell
$env:LOCALIS_BASE_DOMAIN = 'lan.example.com'
$env:CLOUDFLARE_ZONE_ID = '你的 Zone ID'
$env:CLOUDFLARE_API_TOKEN = '最小权限 Token'
$env:ACME_EMAIL = 'you@example.com'
$env:LOCALIS_ACME_STAGING = '1'
npm run tls:provision
```

测试签发成功后移除 staging 开关，再申请正式证书并启动：

```powershell
Remove-Item Env:LOCALIS_ACME_STAGING -ErrorAction SilentlyContinue
npm run tls:provision
npm run start:local
```

账户密钥、证书私钥和缓存默认写入系统应用数据目录，而不是代码仓库。部分路由器会拦截“公共 DNS 返回私有 IP”，此时需检查 DNS rebinding protection/私人域名白名单。完全离线首次使用、头显零证书配置和 WebXR 三者无法同时保证；媒体传输本身不需要公网。

## 播放策略与边界

| 输入 | 默认路径 |
| --- | --- |
| 浏览器可解码的 MP4/WebM/音频且超分关闭 | Range 原文件直放 |
| H.264/AAC 位于 MKV/TS 等容器 | fMP4 HLS remux，不重编码 |
| H.264 + 不兼容音频 | 复制视频，仅转 AAC 音频 |
| MPEG-4 Part 2、VC-1 等不兼容视频 | H.264/AAC HLS |
| 任意视频且超分为标准/高/极致 | 电脑端按需 4 秒缩放锐化分片 + 可全片 seek 的 H.264/AAC MPEG-TS VOD HLS |
| SRT/VTT/ASS/SSA 文本字幕 | WebVTT |

“所有种类”只能通过兼容转码尽量覆盖。首版不处理 DRM、蓝光菜单/加密光盘、PGS/VobSub 位图字幕 OCR 或专有加密容器；Apple 空间视频应优先尝试原文件播放。4K/6K/8K 与 HDR 的最终效果取决于电脑编码能力、Wi-Fi 吞吐和头显解码器。

`.openai/hosting.json` 仅属于现有前端构建脚手架。完整 Localis 必须运行在能读取本机媒体并调用 FFmpeg 的电脑上，不能部署为普通静态网站。

## 常用配置

可复制 [.env.example](./.env.example) 查看完整示例。Vinext/tsx 不会自动读取该文件，请在 shell、服务管理器或启动脚本中设置变量。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LOCALIS_MEDIA_DIRS` | 多个媒体根目录；使用系统路径分隔符连接 | 自带 `sample-media` |
| `LOCALIS_DATA_DIR` | 配置、凭据、TLS 与缓存的私有目录 | 系统应用数据目录 |
| `LOCALIS_PORT` | 对设备暴露的端口 | `8080` |
| `LOCALIS_PAIR_CODE` | 固定六位码；不设则每次启动随机 | 随机 |
| `LOCALIS_MAX_TRANSCODES` | 同时运行的电脑端 HLS/超分任务 | `2` |
| `LOCALIS_CACHE_GB` | HLS 缓存容量上限 | `20` |
| `LOCALIS_CLOUD_CACHE_GB` | 云盘源文件缓存上限 | `50` |
| `LOCALIS_MAX_CLOUD_DOWNLOADS` | 同时下载的云盘源文件数，只允许 `1` 或 `2` | `1` |
| `LOCALIS_QUARK_BASH` | 夸克官方安装器使用的 Bash 路径 | Windows 自动查找 Git Bash |
| `LOCALIS_QUARK_GIT` | 下载/更新夸克官方仓库使用的 Git 可执行文件 | `git` |
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

当前自动化为 12 个文件、59 项测试，覆盖扫描与路径隐藏、配对、Range、字幕、原生选择器协议、Safari/Chromium HLS 分流、四档电脑端超分规划、完整时长 VOD 清单、远距离分片优先生成、SBS/TB 眼间隔离、H.264 Level 5.2 安全范围、真实 FFmpeg HLS、任务租约与回收、硬配额缓存、OpenList WebDAV、百度电脑端加密设置与 OAuth/分页/Range 协议模拟，以及夸克官方 CLI 的版本门禁、artifact、流式进度、不透明结果、完整下载、容量监控、ffprobe 与原子入库。生产构建还在真实 Chromium 中验证了绿色播放器、两小时电影从 10:36 跳到 1:46:32 后继续播放、云盘弹窗布局、LAN 页面管理边界与控制台无错误。

详细记录见 [测试报告](./docs/TEST_REPORT.md)，真机步骤见 [头显验收清单](./docs/HEADSET_ACCEPTANCE.md)。真实 Vision Pro/Quest/PICO、真实夸克账户与真实百度账号仍需由拥有这些设备和凭据的用户完成清单，项目不会把模拟结果冒充真机结果。

## 许可提醒

项目本身尚未附加开源许可证，GitHub 仓库应保持私有。依赖说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。Localis 不捆绑 OpenList；如果用户单独运行 OpenList，应自行遵守其 AGPL-3.0 许可。FFmpeg 许可取决于采用的构建；常见包含 libx264 的 Windows full build 通常适用 GPL。
