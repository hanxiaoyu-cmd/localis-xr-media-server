# Localis 实际测试报告

测试日期：2026-08-25（Asia/Shanghai）

## 环境

- Windows 11 专业版 `10.0.26200`
- Node.js `v24.11.0`，npm `11.13.0`
- FFmpeg/ffprobe `8.1.1-full_build-www.gyan.dev`
- Windows 包内 FFmpeg `6.1.1-essentials`、ffprobe `4.0.2`、Electron `43.4.1`
- GPU：NVIDIA GeForce RTX 5090 D
- 浏览器：Codex 内置 Chromium，生产构建真实页面与媒体元素
- 当前 LAN 地址：`192.168.31.188:8080`

## 已实际通过

| 层级 | 结果 | 验证内容 |
| --- | --- | --- |
| ESLint | 通过 | 全项目无 lint 错误或警告 |
| TypeScript | 通过 | `tsc --noEmit` |
| 单元/集成 | 21 个文件、263 个测试通过 | 配对、Range、扫描、字幕、文件夹选择器、HLS 分流、完整时长 seek、电脑端五档超分、真实 AI/FFmpeg 转码、HDR/高位深分类、设备显示档案、播放路径标签、电脑端云盘工作台、云盘协议与安全边界 |
| 生产构建 | 通过 | Vinext 五阶段 client/RSC/SSR 构建 |
| 编码器探测 | 通过 | NVENC、Media Foundation、libx264 运行时真实编码探测；本机自动选择 NVENC |
| NVENC 路径 | 通过 | 完整集成套件真实生成 H.264/yuv420p + AAC fMP4 HLS |
| Media Foundation 路径 | 18/18 通过 | 强制 `h264_mf` 后完整 API 集成测试通过，含远距离按需分片 |
| libx264 路径 | 18/18 通过 | 强制 `libx264` 后完整 API 集成测试通过，含远距离按需分片 |
| 电脑端超分规划 | 9/9 通过 | 五档解析、绝不反向缩小、Level 5.2、安全像素率、SAR、SBS/TB 拆眼、360 接缝、AI 安全布局与 60 fps 上限 |
| 标准档真实 HLS | 通过 | 1280×720 → 1600×900，按需 MPEG-TS 分片经 FFprobe 确认为 H.264/yuv420p，非关闭档强制电脑转码 |
| AI 清晰完整预处理 | 通过 | 真实 12 秒样片先返回 `202 ai-precompute`，处理期间无播放清单且分片返回 404；三个 4 秒分片全部完成后才原子发布 HLS，FFprobe 确认为 2560×1440 H.264/yuv420p + AAC |
| AI 中间色阶 | 通过 | JPEG 神经网络输出显式从 full range 转换为 limited range，修复首次回归发现的 yuvj420p 标记 |
| 完整时长远距离 seek | 通过 | 12 秒三分片 VOD 清单立即返回；不请求片头，先请求最后一段并验证时间戳从 8 秒附近开始 |
| 高档真实页面 | 通过 | 生产浏览器加载 `/hls/high/index.m3u8`，绿色播放器和超分缓存进度正确显示 |
| VR360 高档 HLS | 通过 | 真实 1280×640 equirect360 经 `v360` 环绕采样输出 1920×960，避免水平接缝钳制 |
| 设备端超分移除 | 通过 | `.super-resolution-canvas` 为 0；唯一 canvas 是隐藏的 XR stage，视频使用无 emoji 的绿色 HTML 控制条 |
| 长片跳转后连续播放 | 通过 | 真实 2:22:03 电影从 10:36 直接跳到 1:46:32，高档超分生成目标分片后播放推进到 1:46:37，`readyState=4`、无媒体错误 |
| HLS 浏览器分流 | 3/3 通过 | Vision Pro/Apple Safari 保留原生 HLS；Quest/PICO/桌面 Chromium 优先 hls.js；无 MediaSource 时安全回退 |
| OpenList/WebDAV | 通过 | 真实本机 mock HTTP 服务：Depth 1 的 207 XML、嵌套目录、自身目录去重、越界 href 过滤、Basic Auth、Range、完整缓存 |
| WebDAV 安全边界 | 通过 | 拒绝远程地址与 URL 内嵌凭据；存储 JSON 中无明文密码；重启后可用密钥解密并重新扫描 |
| 百度设备码 OAuth | 通过（协议模拟） | device code、二维码、token、`/apps/Localis` 递归列表、filemetas dlink、302、必需 UA 与 Range |
| 百度电脑端首次设置 | 通过 | localhost 一次提交 AppKey/SecretKey/应用目录、AES-256-GCM 持久化、重启恢复、环境配置优先、删除设置；LAN 接口拒绝访问 |
| 夸克官方组件契约 | 4/4 通过 | 版本门禁、artifact 全量媒体、流式 NDJSON 进度、浏览器登录、手动授权码、不透明选择 ID、完整下载、总容量拒绝、ffprobe、原子入库与未登录错误 |
| 夸克官方组件实机探测 | 通过（未登录） | 生产 API 实际安装官方 `1.0.14-ee6c8bc`，确认 CLI 文件 SHA-256，并由真实官方 CLI 返回预期的 `401 未登录`；没有伪造真实账号结果 |
| 云盘电脑端界面 | 3/3 通过 | 百度未配置时显示首次设置；配置后自动进入扫码；夸克显示安装/授权/搜索/下载任务；高级 WebDAV 默认折叠 |
| 百度凭据保护 | 通过 | connector 与授权来源均不含 AppKey、SecretKey、Access/Refresh Token 明文；v1 明文 AppKey 自动迁移；损坏 key 文件安全失败且不会被覆盖 |
| 云盘媒体脱敏 | 通过 | 公共媒体 JSON 不含 `remoteFileId`、OpenList 地址或本机上游端口 |
| 云盘缓存 | 通过 | 默认串行下载、50 GB 可配置硬配额、磁盘余量保护、`507`、原子重命名、崩溃 `.part` 清理及持久缓存清单 |
| 云盘 → 电脑超分 | 通过 | WebDAV 提供真实 1280×720 MP4，电脑完整缓存并 ffprobe 后按需生成 1600×900 Standard HLS 分片；后续请求命中同一缓存 |
| Windows 原生文件夹选择器 | 通过 | 真实系统窗口的取消、选中、自动重新扫描；中文路径另有单元测试 |
| 本机/局域网管理边界 | 通过 | `localhost` 显示文件夹与云盘按钮；LAN 页面两类按钮数量均为 0，24 个媒体仍正常展示；LAN 云盘管理 API 返回 403 |
| 原文件播放 | 通过 | 1280×720 H.264/AAC MP4 Range 直连，`readyState=4` |
| HLS 兼容播放 | 通过 | AVI/MPEG-4 Part 2 + PCM 转 H.264/AAC，浏览器可播放 |
| 字幕 | 通过 | 中文 SRT 转 WEBVTT，普通播放器加载同源 `<track>` |
| 安全错误路径 | 通过 | 未知 Host 421、Origin 不匹配 403、HLS traversal 404、非法超分档位 400，均不会启动错误任务 |
| 内部界面端口 | 通过 | Vinext 仅绑定 `127.0.0.1:3210`，LAN 只暴露带配对与安全头的 8080 |
| 依赖审计 | 通过 | `npm audit --audit-level=low`：0 个已知漏洞 |
| 浏览器控制台 | 通过 | 最终 localhost 播放器、云盘弹窗与 LAN 首页均为 0 个 error/warning |
| Windows 安装版 | 通过 | NSIS 静默安装到隔离目录，包内 AI 运行时/模型/许可证齐全；安装后真实启动、扫描、传统超分与 AI 推理，再由自带卸载器移除 |
| Windows 便携版 | 通过 | 最终 Release EXE 首次解压并真实启动；内置 ffprobe 扫描 14 个媒体，FFmpeg/NVENC 生成 4,765,048 字节传统分片，Real-ESRGAN 生成 2,750,628 字节 AI 分片 |
| 桌面安全边界 | 通过 | localhost 自动完成电脑端配对并显示六位码；通过 `192.168.31.87` 请求的 LAN 客户端响应不含配对码，管理能力仍不可见 |
| 最终桌面视觉 | 通过 | 最终便携版页面实际截图检查：绿色/石墨控制台、配对码卡片、播放器进度与电脑端超分状态正常；浏览器 0 个 error/warning |

### HLS 输出实测

API 集成测试不是模拟 FFmpeg。兼容流请求真实 fMP4 HLS；超分流先取得覆盖整片的 VOD 清单，再直接请求目标 MPEG-TS 分片并运行 ffprobe，断言：

```text
video: h264, yuv420p
audio: aac
compatibility playlist: EXT-X-MAP + EXT-X-ENDLIST
super-resolution playlist: EXT-X-PLAYLIST-TYPE:VOD + full-duration EXTINF entries
far seek: request seg_000002.ts before seg_000000.ts
standard SR: 1280x720 -> 1600x900
AI SR: 1280x720 -> 2560x1440, 1-second segments, Real-ESRGAN NCNN Vulkan
```

回归还覆盖：

- H.264 High10 → 8-bit yuv420p。
- 641×359 奇数尺寸 → H.264 兼容偶数尺寸。
- 16:15 SAR → 4:3 方形像素显示比例。
- 120 fps → 不超过 60 fps。
- SBS 与 TB 每只眼独立缩放和锐化，滤镜图不会跨眼取样。
- `off`、`standard`、`high`、`ultra`、`ai` 使用不同缓存键。
- 旧 HLS 缓存不会污染 `v8-precomputed-ai-sr` 管线。
- 两个同时转码槽被占满时返回 `503 + Retry-After`，释放后可重试。
- 播放者持有 60 秒共享租约；页面放弃后由 15 秒清理器停止过期 FFmpeg，活跃请求不会被误杀。

### 云盘协议实测

自动化在 `127.0.0.1` 启动真实 HTTP mock 服务，不是只 mock `fetch` 函数：

- OpenList 路径执行实际 PROPFIND 与 GET；测试多级目录、XML 命名空间、中文路径、成功 propstat、Range 206、慢响应体、拒绝 302、完整缓存和凭据重载。
- OpenList 返回的真实 MP4 会先落盘并由 ffprobe 补齐元数据，再通过与本地文件相同的 Standard 超分管线输出 1600×900 H.264 HLS。
- 恶意 WebDAV 响应中的 `/dav/Other/escape.mp4` 不会进入媒体库。
- 百度流程执行实际 HTTP device code/token/listall/filemetas/302/download；验证两页 `start` 游标、超过 JavaScript 安全整数的 `fs_id` 不丢精度，并断言下载端收到 `User-Agent: pan.baidu.com`、原始 Range 和 Access Token。
- 二维码由真实 `qrcode` 依赖生成 PNG data URL。
- `/api/cloud/connectors` 不返回 AppKey、SecretKey、Token、夸克 FID 或 WebDAV 密码；百度设置只允许 localhost 写入并加密落盘。
- 夸克契约替身输出与官方 NDJSON 的 `result/progress/data` 结构一致；下载命令只接收服务端保存的 FID，浏览器只能提交短期 UUID，输出路径始终由服务端决定。
- 生产服务实际从官方仓库安装组件，版本为 `1.0.14-ee6c8bc`；未登录搜索由官方 CLI 返回 `未登录，请先执行 login 命令完成登录授权`，Localis 正确映射为 HTTP 401。
- 生产 Chromium 实际打开云盘弹窗：百度首次设置表单与夸克安装后“打开电脑浏览器授权”入口均可用；LAN 页面不渲染云盘按钮，直接请求管理 API 返回 403；控制台为 0 个 error/warning。

这些测试证明 Localis 的协议实现和安全边界，不证明第三方服务账户当前可用，也不替代真实账号授权。

## 真实浏览器中发现并修复

1. 旧设备端 WebGL 超分会把原生视频隐藏在 canvas 后面；Safari 视频纹理停止刷新时，字幕仍会单独推进。现在删除了整条设备端 shader/render-target 管线，WebXR 直接读取电脑生成的 HLS 视频纹理。
2. LAN 页面在服务信息尚未加载时读取 `window.location.hostname`，SSR 与首次客户端渲染结果不同，生产 React 报 hydration #418。现在安全提示只在 `/api/server` 返回后渲染；全新 LAN 标签页复验控制台为 0。
3. WebDAV Depth 1 响应包含请求目录本身；子目录原本可能被重复加入队列。现在显式跳过当前 collection，并用嵌套目录测试锁定行为。
4. 编码 traversal 形状的 HLS 文件名曾可能在返回 404 前创建任务；现在先做严格文件名白名单。
5. 非法超分档位原本会静默降级为 `off`；路由现在返回明确的 `400 invalid_super_resolution_level`。
6. Windows 上 FFmpeg `exit` 可能早于最终播放列表原子落盘；任务继续等待 stdio 完全关闭的 `close` 事件。
7. Chromium 的 `canPlayType` 在此环境声称可原生播放 HLS，但实际点击后曾出现 `DEMUXER_ERROR_COULD_NOT_PARSE`。现在只有 Apple Safari（含 Vision Pro）优先原生 HLS；Quest/PICO 与桌面 Chromium 优先 hls.js，生产页面复验为 blob MediaSource、无媒体错误且时间实际推进。
8. 原云盘窗口把百度应用身份和 OpenList 参数都当作日常导入步骤。现在百度只在电脑端首次设置并加密保存，之后直接扫码；夸克改用官方组件在电脑浏览器 OAuth，再在电脑上搜索和完整下载，不把第三方明文换票链路包装成快捷登录。
9. 云盘弹窗新增多阶段表单后，过宽的 CSS 后代选择器曾把整个弹窗根节点变成横向 flex。真实浏览器截图发现后已把规则限定到具体表单，百度与夸克页面重新截图复验布局正常。
10. 顺序 EVENT HLS 只暴露已转码到的时间范围，Vision Pro 选择超分后无法拖到长片后段。现在非关闭档立即发布完整 VOD 时间线，Safari/HLS 请求哪个 4 秒分片，电脑就从对应时间点优先生成；绿色控制条同时显示当前分片进度、处理倍速和总缓存覆盖率。真实 2:22:03 电影已从 10:36 跳到 1:46:32 并继续播放。
11. AI 中间 JPEG 是 full-range 色阶，首次真实 NVENC 回归把成品标记为 `yuvj420p`。现在输出阶段显式转换为 limited range 并写入 range metadata，最终 ffprobe 为 visionOS 更稳妥的 `yuv420p`。

## 尚未声称通过

当前环境没有可远程控制的 Vision Pro、Quest、PICO 真机，也没有用户的真实云盘凭据。因此以下项目没有被虚假标记为通过：

- Vision Pro Safari 真机中的原生 HLS、WebXR 视频纹理、手势 transient-pointer、沉浸音频和 30 分钟稳定性。
- Quest/PICO 控制器、真机解码器、4K/6K/8K 与 HDR 差异。
- 真实夸克账号的官方 OAuth、搜索、完整下载、重启后登录态和头显播放。本机 WSL 因 hypervisor 未启用而无法启动，Windows 本机兼容模式也不等于官方支持。
- 真实夸克账号 + OpenList 高级兼容入口的登录过期、限速、10%/50%/90% seek 与长时播放。
- 真实百度开发者 AppKey/SecretKey、扫码授权、账户目录权限、会员/非会员下载速度与 dlink 过期。
- 公网可信 DNS-01 证书实际签发；缺少用户域名与 Cloudflare Token。
- 真实 Wi-Fi 抖动、90 分钟 soak、电脑极致档并行负载。

当前电脑端包含两条可验证路径：标准/高/极致使用空间缩放 + CAS，AI 清晰使用随包 Real-ESRGAN NCNN Vulkan 神经网络。当前测试证明电脑端模型与 HLS 输出有效，不等于 Vision Pro/Quest/PICO 真机已验收；发布真机或真实云盘兼容声明前，必须完成 [HEADSET_ACCEPTANCE.md](./HEADSET_ACCEPTANCE.md)。

## 上次 Windows 产物

以下 EXE 是引入 AI 运行时后的上一轮可复现产物。本轮“AI 全片完成后才播放”的源码改动按项目约定没有重新打包，因此这些文件仍是旧的按需 AI 播放行为；下次明确发布版本时再统一重建并更新哈希。

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `Localis-Setup-0.3.0-x64.exe` | 208,766,617 bytes | `FE085493F66A721098E113D44A79AD1969BCA0ABC9C2F4D45F145FD5739F4772` |
| `Localis-Portable-0.3.0-x64.exe` | 208,346,726 bytes | `C1CCEF4A42D2D08708CE16506EE2EA3AEF370EF2515A38AAA3282A3BB3AF7B3F` |
