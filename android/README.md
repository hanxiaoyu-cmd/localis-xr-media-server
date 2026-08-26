# Localis Android Player Beta

这是 Localis XR Media Server 的原生 Kotlin Android 基础播放器。它面向 Android 手机、平板以及可运行普通 Android APK 的头显，用于验证“连接、配对、媒体库、原片播放、兼容回退、续播”这一条最小闭环。

## Beta 能力

- Jetpack Compose 原生界面，手动输入 Localis 服务器地址。
- 连接前校验 `/api/health`，只接受 `ok=true` 且 `service=localis` 的服务。
- 使用六位配对码建立 30 天会话；`localis_session` Cookie 以 Android Keystore AES-GCM 密钥加密后保存在应用私有存储中。
- API、原始媒体 Range 请求、HLS manifest/init/segment 共用同一个 OkHttp 客户端与 CookieJar。
- 展示 `/api/library` 返回的视频和音频，并恢复服务器保存的播放位置。
- Media3 `PlayerView` 首先直接播放服务器返回的 `item.streamUrl`。
- 视频原片失败时，客户端先轮询 `/api/media/{id}/hls/compat/index.m3u8`；只有收到 HTTP 200、正确的 m3u8 Content-Type 且正文以 `#EXTM3U` 开头后才交给 Media3。
- 播放期间每 8 秒、应用进入后台、播放结束或离开播放器时调用 `PUT /api/progress/{id}`。
- 网络策略只允许原始流和单一兼容 HLS 路径；不会请求画质增强档位。

本 Beta 不包含服务器自动发现、二维码扫码、沉浸式 XR 球幕渲染、字幕/音轨选择、离线下载或后台播放。

## 地址与安全规则

首版没有 mDNS 或二维码 API，必须输入服务器根地址，例如：

```text
192.168.1.100:8081
https://media.example.com
```

- HTTP 只允许 `10/8`、`172.16/12`、`192.168/16`、`127/8`、`localhost` 和 IPv6 ULA/loopback 地址。
- 公网主机名和公网 IP 必须使用 HTTPS。
- 为兼容未配置 TLS 的局域网服务器，应用允许私有 LAN 明文 HTTP；其内容和会话在网络上不加密，应优先使用可信 HTTPS。
- Network Security Config 同时信任 Android 系统 CA 和用户安装的 CA，可配合局域网自建可信证书使用。
- 所有非 GET 请求由拦截器添加与服务器协议、主机、端口完全一致的 `Origin`。
- 禁止跨域媒体 URL与写请求，禁用 HTTP/HTTPS 自动重定向，避免会话被带到其他来源。
- Android 备份已关闭，避免应用私有会话随系统备份迁移。

## 构建环境

版本组合锁定为：

- JDK 17
- Gradle 8.13
- Android Gradle Plugin 8.13.2
- Kotlin / Compose Compiler plugin 2.3.21
- compileSdk / targetSdk 36，minSdk 26
- Compose BOM 2026.06.00（Compose 1.11，兼容 compileSdk 36 / AGP 8.13）
- Media3 1.11.0（ExoPlayer、HLS、PlayerView、OkHttp data source）

准备 Android SDK 36 和 JDK 17 后，在本目录执行：

```bash
./gradlew :app:testDebugUnitTest :app:lintBeta :app:assembleBeta --no-daemon
```

Windows：

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintBeta :app:assembleBeta --no-daemon
```

不可调试的 Beta APK 位于 `app/build/outputs/apk/beta/app-beta.apk`。安装后确保 Android 设备与运行 Localis 的电脑处于同一局域网，并允许电脑防火墙放行 Localis 端口。日常开发仍可单独运行 `assembleDebug`。

GitHub Actions 仅使用仓库策略允许的 GitHub 官方 `actions/*`：Temurin JDK 17 与 Gradle 缓存由 `actions/setup-java` 配置，Android SDK 由 Runner 内置 `sdkmanager` 安装，构建使用仓库内 Wrapper。每次推送 `Android_beta` 后，Actions 会上传保留 14 天的 `Localis-Android-beta-<commit>` 安装包与 SHA-256 文件。

当前 CI 产物本身不可调试，但仍使用 Runner 临时 Debug 密钥签名，只适合 Beta 验证。不同 CI 构建可能无法直接覆盖安装，届时需要卸载旧版（应用内保存的服务器地址和会话也会被清除）；建立长期 Beta/正式发布前需配置受保护且持续备份的固定签名密钥。

## 测试范围

基础 JVM 单测覆盖：

- LAN HTTP / 公网 HTTPS 地址约束及同源 URL 解析。
- 非 GET 请求的精确 Origin 注入。
- 配对 Cookie 跨 CookieJar 重建后的持久恢复。
- 除兼容 HLS 外的其他 HLS 路径硬阻断。
- 配对、Cookie 复用、媒体库和进度写入的请求合同。
- 兼容 manifest 从 202 轮询到有效 m3u8 后才返回给播放器。
- 对 chunked/未知长度的 API 和 manifest 响应执行分块读取与硬上限，避免过量内存分配。

真机发布前仍需在目标 Android 头显上验证硬件解码、HDR、长时间 Range 读取、Wi-Fi 漫游、后台恢复和 90 分钟浸泡播放。
