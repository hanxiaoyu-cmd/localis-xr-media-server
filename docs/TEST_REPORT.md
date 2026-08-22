# Localis 实际测试报告

测试日期：2026-08-23（Asia/Shanghai）

## 环境

- Windows 11 专业版 `10.0.26200`
- Node.js `v24.11.0`，npm `11.13.0`
- FFmpeg/ffprobe `8.1.1-full_build-www.gyan.dev`
- GPU：NVIDIA GeForce RTX 5090 D（系统同时存在虚拟显示适配器）
- 浏览器：Codex 内置 Chromium 浏览器，真实页面与媒体元素测试

## 已实际通过

| 层级 | 结果 | 验证内容 |
| --- | --- | --- |
| ESLint | 通过 | 全项目无 lint 错误/警告 |
| TypeScript | 通过 | `tsc --noEmit` |
| 单元/集成 | 7 个文件、30 个测试通过 | 配对、Range、扫描、字幕、原生选择器协议、超分规划/眼间边界、API、真实转码、缓存版本与转码容量重试 |
| 生产构建 | 通过 | Vinext 五阶段 client/RSC/SSR 构建 |
| 编码器探测 | 通过 | NVENC、MF、libx264 运行时真实编码探测；本机自动选择 NVENC |
| NVENC 转码 | 通过 | AVI MPEG-4 Part 2 + PCM → fMP4 HLS H.264/yuv420p + AAC |
| Media Foundation 回退 | 11/11 通过 | 强制 `h264_mf` 后完整 API 集成测试通过；非方形像素转为 4:3 方形像素尺寸 |
| libx264 路径 | 11/11 通过 | 强制 `libx264` 后完整 API 集成测试通过 |
| HLS 播放 | 通过 | 浏览器加载 m3u8，`readyState=4`，3.12 秒 AVI 兼容流可播放 |
| 原文件播放 | 通过 | 1280×720 H.264/AAC MP4 Range 直连，`readyState=4`，无媒体错误 |
| Windows 原生文件夹选择器 | 通过 | 生产页面实际打开系统“浏览文件夹”窗口；分别真实取消、选中预置目录并自动重新扫描，中文路径编码另有单元测试 |
| 本机/远程管理边界 | 通过 | `localhost` 显示文件夹按钮；`192.168.31.87` 局域网页面按钮数量为 0，API 分别报告 `canPickLocalFolder=true/false` |
| WebGL 超分 shader | 通过 | 真实 Chromium 编译与连续渲染，最终控制台 0 个 shader/WebGL 警告或错误 |
| 原文件实时超分 | 通过 | 1280×720 → 1920×1080；2.2 秒内超分帧计数 3→75，媒体时间推进到 2.35 秒 |
| HLS 实时超分 | 通过 | 640×360 → 960×540；1.8 秒内超分帧计数 3→50，媒体时间推进到 1.83 秒 |
| 超分档位切换 | 通过 | 高画质 1920×1080、仅锐化 1280×720、自动 1920×1080、关闭恢复原生 `<video>` |
| 超分亮度一致性 | 通过 | 同一最终帧开/关截图：YAVG 66.2328 / 66.3354，差 0.1026（约 0.15%），未发生 sRGB 二次解码变暗 |
| VR180 SBS 超分 | 通过 | 1280×640 → 1920×960；紫/青左右眼测试图可见硬边界，着色器与 XR UV 均限制在当前眼的半纹理内 |
| VR360 超分 | 通过 | 1280×640 → 1920×960；1.2 秒播放后媒体时间 1.27 秒、46 个输出帧、控制台无错误 |
| 播放进度 | 通过 | 播放后 API 持久化位置 4 秒，首页“最近播放”只返回该项目 |
| 字幕 | 通过 | 中文 SRT 实际转换为 WEBVTT，普通播放器加载同源 track |
| 海报/媒体库 | 通过 | 13 个现场生成项目与真实 FFmpeg 海报均加载 |
| 搜索 | 通过 | 输入 `flat` 只返回 `flat-remux`、`flat-demo` |
| 响应式布局 | 通过 | 390×844：13 个项目加载、侧栏隐藏、无横向溢出 |
| 安全错误路径 | 通过 | 未知 Host 421、Origin 不匹配 403、编码 traversal 404 且不启动 FFmpeg |
| 内部界面端口 | 通过 | Vinext 上游只绑定 `127.0.0.1:3210`，局域网仅暴露带配对与安全头的 `8080` 入口 |
| TLS 启动闭锁 | 通过 | 缺私钥、SAN 不匹配、证书/私钥不匹配均拒绝启动；匹配证书实际 HTTPS 监听 |
| 依赖审计 | 通过 | `npm audit`（含开发依赖）0 个已知漏洞 |

### HLS 输出实测

集成测试不是模拟 FFmpeg：它请求真实 API，等待分片生成，再对播放列表运行 ffprobe。断言至少包含：

```text
video: h264, yuv420p
audio: aac
playlist: EXT-X-MAP + EXT-X-ENDLIST
```

测试还逐字节比较 `bytes=10-29` 与源文件切片，验证 suffix Range、`HEAD bytes=0-0` 与越界 `416`。
转码回归还覆盖 H.264 High10→8-bit yuv420p、641×359 奇数尺寸、16:15 SAR→4:3 方形像素尺寸、120fps→不超过 60fps，以及旧 `v2` HLS 缓存不会污染 `v3` 管线。

## 测试中发现并修复

1. 编码后的 traversal 形状 HLS 文件名曾在返回 404 前启动 FFmpeg，占满单转码槽；现在先做严格文件名白名单，再创建任务。
2. Cookie 篡改用例原先修改的是 `SameSite` 属性末尾而非签名；现在直接改变 HMAC 签名并确认返回 401。
3. FFmpeg `h264_mf` 的裸探测参数与生产参数不一致；现在探测复用编码参数，MF 使用 NV12 + quality 模式，并以真实集成测试验证。
4. Vinext 开发运行时优化 `next/link` 时出现重复 React Context/Hook 错误；播放器改用稳定的同源普通导航后页面恢复且媒体 `readyState=4`。
5. “最近播放”最初只改变标题而未筛选；现在以持久化进度实际过滤。
6. 浏览器在跳转和 seek 时会取消 Range 请求；现在同一打开句柄通过 `pipeline` 生命周期显式关闭，并在响应已发送后正确忽略正常的提前断开。
7. 单转码槽被占用时曾返回 500；现在返回 `503 + Retry-After`，播放器会轮询并在槽位释放后继续准备。
8. 像素格式、纵横比和帧率规则升级后缓存 schema 已提升到 `v3`，防止复用旧错误产物。
9. 原生选择器返回的 Base64 最初只依赖 Node 宽松解码；现在要求规范 Base64、有效 UTF-8 和非空路径。
10. 空路径最初会被 `path.resolve('')` 解释为项目根目录；现在在解析前返回可读的 `400 invalid_media_directory`。
11. Three.js 内置 shader chunk 与首版超分着色器的 `luminance` 函数重名，真实 Chromium 编译失败；已改成项目私有函数名并在全新标签页确认控制台无错误。
12. 超分输入纹理最初存在潜在 sRGB 二次解码风险；现在超分 pass 以 `NoColorSpace` 读取感知域值，最终只做一次线性化，截图亮度差实测约 0.15%。
13. 8K/超纹理预算、逐帧 React 诊断更新和普通/XR 双份 render target 会带来崩溃或显存浪费；现在超预算恢复原生播放、诊断最多约 1 Hz 更新，进入 XR 时释放普通播放器 RT。
14. Windows 上 FFmpeg `exit` 事件可能早于最终 HLS 播放列表原子落盘；现在等待 stdio 全部关闭的 `close` 事件后才把任务标为 ready。

## 尚未声称通过

本环境没有可远程控制的 Vision Pro、Quest 和 PICO 真机。因此下面这些不能由桌面 Chromium、模拟器或 `navigator.xr` 缺失环境替代，也没有被虚假标记为通过：

- Vision Pro Safari 的 WebXR 视频纹理、眼睛/手部 transient-pointer、沉浸音频和长时性能。
- Vision Pro/Quest/PICO 真机中的超分画质、4K 进入/退出 XR 显存、GPU context loss 自动降级、30 分钟发热与丢帧。
- Quest/PICO 控制器射线与真机解码器差异。
- 公网可信 DNS-01 证书的实际签发；缺少用户的域名、Cloudflare Zone 与 API Token，脚本已静态检查和构建，但没有对外部 DNS 产生变更。
- 4K/6K/8K、HDR、90 分钟 soak 和真实 Wi-Fi 抖动。

桌面 Chromium 已证明同一 shader 可以编译、输出正确亮度并处理普通、HLS、SBS 与 360° 样本，但不能替代头显的 XR framebuffer、Safari 视频纹理实现或真机热约束。

发布兼容声明前必须完成 [HEADSET_ACCEPTANCE.md](./HEADSET_ACCEPTANCE.md)。
