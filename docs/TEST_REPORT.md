# Localis 实际测试报告

测试日期：2026-08-23（Asia/Shanghai）

## 环境

- Windows 11 专业版 `10.0.26200`
- Node.js `v24.11.0`，npm `11.13.0`
- FFmpeg/ffprobe `8.1.1-full_build-www.gyan.dev`
- GPU：NVIDIA GeForce RTX 5090 D
- 浏览器：Codex 内置 Chromium，生产构建真实页面与媒体元素
- 当前 LAN 地址：`192.168.31.87:8080`

## 已实际通过

| 层级 | 结果 | 验证内容 |
| --- | --- | --- |
| ESLint | 通过 | 全项目无 lint 错误或警告 |
| TypeScript | 通过 | `tsc --noEmit` |
| 单元/集成 | 10 个文件、49 个测试通过 | 配对、Range、扫描、字幕、文件夹选择器、HLS 分流、电脑端超分、真实转码、云盘协议与安全边界 |
| 生产构建 | 通过 | Vinext 五阶段 client/RSC/SSR 构建 |
| 编码器探测 | 通过 | NVENC、Media Foundation、libx264 运行时真实编码探测；本机自动选择 NVENC |
| NVENC 路径 | 通过 | 完整集成套件真实生成 H.264/yuv420p + AAC fMP4 HLS |
| Media Foundation 路径 | 17/17 通过 | 强制 `h264_mf` 后完整 API 集成测试通过 |
| libx264 路径 | 17/17 通过 | 强制 `libx264` 后完整 API 集成测试通过 |
| 电脑端超分规划 | 8/8 通过 | 四档解析、绝不反向缩小、Level 5.2、安全像素率、SAR、SBS/TB 拆眼、360 接缝与 60 fps 上限 |
| 标准档真实 HLS | 通过 | 1280×720 → 1600×900，FFprobe 确认为 H.264/yuv420p，非关闭档强制电脑转码 |
| 高档真实页面 | 通过 | 1280×720 → 1920×1080，生产浏览器加载 `/hls/high/index.m3u8` |
| VR360 高档 HLS | 通过 | 真实 1280×640 equirect360 经 `v360` 环绕采样输出 1920×960，避免水平接缝钳制 |
| 设备端超分移除 | 通过 | `.super-resolution-canvas` 为 0；唯一 canvas 是隐藏的 XR stage，普通播放保留原生 `<video controls>` |
| 连续播放 | 通过 | 标准档与高档均为 `readyState=4`；分别观察到媒体时间推进至 2.13 秒和 2.19 秒且仍在播放 |
| HLS 浏览器分流 | 3/3 通过 | Vision Pro/Apple Safari 保留原生 HLS；Quest/PICO/桌面 Chromium 优先 hls.js；无 MediaSource 时安全回退 |
| OpenList/WebDAV | 通过 | 真实本机 mock HTTP 服务：Depth 1 的 207 XML、嵌套目录、自身目录去重、越界 href 过滤、Basic Auth、Range、完整缓存 |
| WebDAV 安全边界 | 通过 | 拒绝远程地址与 URL 内嵌凭据；存储 JSON 中无明文密码；重启后可用密钥解密并重新扫描 |
| 百度设备码 OAuth | 通过（协议模拟） | device code、二维码、token、`/apps/Localis` 递归列表、filemetas dlink、302、必需 UA 与 Range |
| 百度凭据保护 | 通过 | 持久化文件中不包含 SecretKey、Access Token 或 Refresh Token 明文 |
| 云盘媒体脱敏 | 通过 | 公共媒体 JSON 不含 `remoteFileId`、OpenList 地址或本机上游端口 |
| 云盘缓存 | 通过 | 默认串行下载、50 GB 可配置硬配额、磁盘余量保护、`507`、原子重命名、崩溃 `.part` 清理及持久缓存清单 |
| 云盘 → 电脑超分 | 通过 | WebDAV 提供真实 1280×720 MP4，电脑完整缓存并 ffprobe 后生成 1600×900 Standard HLS；后续分片命中同一任务 |
| Windows 原生文件夹选择器 | 通过 | 真实系统窗口的取消、选中、自动重新扫描；中文路径另有单元测试 |
| 本机/局域网管理边界 | 通过 | `localhost` 显示文件夹与云盘按钮；LAN 页面两类按钮数量均为 0，13 个媒体仍正常展示 |
| 原文件播放 | 通过 | 1280×720 H.264/AAC MP4 Range 直连，`readyState=4` |
| HLS 兼容播放 | 通过 | AVI/MPEG-4 Part 2 + PCM 转 H.264/AAC，浏览器可播放 |
| 字幕 | 通过 | 中文 SRT 转 WEBVTT，普通播放器加载同源 `<track>` |
| 安全错误路径 | 通过 | 未知 Host 421、Origin 不匹配 403、HLS traversal 404、非法超分档位 400，均不会启动错误任务 |
| 内部界面端口 | 通过 | Vinext 仅绑定 `127.0.0.1:3210`，LAN 只暴露带配对与安全头的 8080 |
| 依赖审计 | 通过 | `npm audit --audit-level=low`：0 个已知漏洞 |
| 浏览器控制台 | 通过 | 最终 localhost 播放器、云盘弹窗与 LAN 首页均为 0 个 error/warning |

### HLS 输出实测

API 集成测试不是模拟 FFmpeg。它请求真实 HLS 路径、等待分片生成，再对播放列表运行 ffprobe，断言：

```text
video: h264, yuv420p
audio: aac
playlist: EXT-X-MAP + EXT-X-ENDLIST
standard SR: 1280x720 -> 1600x900
```

回归还覆盖：

- H.264 High10 → 8-bit yuv420p。
- 641×359 奇数尺寸 → H.264 兼容偶数尺寸。
- 16:15 SAR → 4:3 方形像素显示比例。
- 120 fps → 不超过 60 fps。
- SBS 与 TB 每只眼独立缩放和锐化，滤镜图不会跨眼取样。
- `off`、`standard`、`high`、`ultra` 使用不同缓存键。
- 旧 HLS 缓存不会污染 `v5-server-sr-safe` 管线。
- 两个同时转码槽被占满时返回 `503 + Retry-After`，释放后可重试。
- 播放者持有 60 秒共享租约；页面放弃后由 15 秒清理器停止过期 FFmpeg，活跃请求不会被误杀。

### 云盘协议实测

自动化在 `127.0.0.1` 启动真实 HTTP mock 服务，不是只 mock `fetch` 函数：

- OpenList 路径执行实际 PROPFIND 与 GET；测试多级目录、XML 命名空间、中文路径、成功 propstat、Range 206、慢响应体、拒绝 302、完整缓存和凭据重载。
- OpenList 返回的真实 MP4 会先落盘并由 ffprobe 补齐元数据，再通过与本地文件相同的 Standard 超分管线输出 1600×900 H.264 HLS。
- 恶意 WebDAV 响应中的 `/dav/Other/escape.mp4` 不会进入媒体库。
- 百度流程执行实际 HTTP device code/token/listall/filemetas/302/download；验证两页 `start` 游标、超过 JavaScript 安全整数的 `fs_id` 不丢精度，并断言下载端收到 `User-Agent: pan.baidu.com`、原始 Range 和 Access Token。
- 二维码由真实 `qrcode` 依赖生成 PNG data URL。

这些测试证明 Localis 的协议实现和安全边界，不证明第三方服务账户当前可用，也不替代真实账号授权。

## 真实浏览器中发现并修复

1. 旧设备端 WebGL 超分会把原生视频隐藏在 canvas 后面；Safari 视频纹理停止刷新时，字幕仍会单独推进。现在删除了整条设备端 shader/render-target 管线，WebXR 直接读取电脑生成的 HLS 视频纹理。
2. LAN 页面在服务信息尚未加载时读取 `window.location.hostname`，SSR 与首次客户端渲染结果不同，生产 React 报 hydration #418。现在安全提示只在 `/api/server` 返回后渲染；全新 LAN 标签页复验控制台为 0。
3. WebDAV Depth 1 响应包含请求目录本身；子目录原本可能被重复加入队列。现在显式跳过当前 collection，并用嵌套目录测试锁定行为。
4. 编码 traversal 形状的 HLS 文件名曾可能在返回 404 前创建任务；现在先做严格文件名白名单。
5. 非法超分档位原本会静默降级为 `off`；路由现在返回明确的 `400 invalid_super_resolution_level`。
6. Windows 上 FFmpeg `exit` 可能早于最终播放列表原子落盘；任务继续等待 stdio 完全关闭的 `close` 事件。
7. Chromium 的 `canPlayType` 在此环境声称可原生播放 HLS，但实际点击后曾出现 `DEMUXER_ERROR_COULD_NOT_PARSE`。现在只有 Apple Safari（含 Vision Pro）优先原生 HLS；Quest/PICO 与桌面 Chromium 优先 hls.js，生产页面复验为 blob MediaSource、无媒体错误且时间实际推进。

## 尚未声称通过

当前环境没有可远程控制的 Vision Pro、Quest、PICO 真机，也没有用户的真实云盘凭据。因此以下项目没有被虚假标记为通过：

- Vision Pro Safari 真机中的原生 HLS、WebXR 视频纹理、手势 transient-pointer、沉浸音频和 30 分钟稳定性。
- Quest/PICO 控制器、真机解码器、4K/6K/8K 与 HDR 差异。
- 真实夸克账号 + OpenList 驱动的登录过期、限速、10%/50%/90% seek 与长时播放。
- 真实百度开发者 AppKey/SecretKey、扫码授权、账户目录权限、会员/非会员下载速度与 dlink 过期。
- 公网可信 DNS-01 证书实际签发；缺少用户域名与 Cloudflare Token。
- 真实 Wi-Fi 抖动、90 分钟 soak、电脑极致档并行负载。

当前电脑端引擎是可验证的空间缩放 + CAS 锐化，不是 AI/神经超分。发布真机或真实云盘兼容声明前，必须完成 [HEADSET_ACCEPTANCE.md](./HEADSET_ACCEPTANCE.md)。
