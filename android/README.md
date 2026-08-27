# Localis Android Server Beta

Android 版的定位是“安卓架服务器，头显零安装播放”，不是安卓本地播放器。安装 APK 后，手机或平板从用户授权的媒体文件夹建立索引，并在局域网提供网页、API 和原片字节流。Quest、PICO、Vision Pro 或其他设备仅需使用浏览器。

## 使用方法

1. 将 APK 安装到安卓手机或平板，让安卓设备与头显连接同一 Wi-Fi、热点或以太网。
2. 打开 Localis XR Server，点击“选择媒体文件夹”，授权一个包含视频的目录。
3. 等待索引完成。服务器默认使用固定端口 `8081`，也可在启动前修改；如已配置 Cloudflare 域名，还可填入精确的“可信 HTTPS 外部来源”，例如 `https://xr.example.com`。
4. 点击“启动服务器”。安卓端会显示完整的局域网地址、已配置的 HTTPS 地址和六位配对码。
5. 在头显浏览器输入显示的地址，例如 `http://192.168.1.23:8081` 或 `https://xr.example.com`，再输入安卓端当次显示的配对码。
6. 在媒体库中搜索、打开并播放原片。停止安卓服务器后，本次配对会话立即失效。

服务器启动后会以前台服务运行，通知栏可以直接停止共享。运行期间会持有 Wi-Fi 高性能锁和部分唤醒锁，长时间使用时建议接通电源。

## Cloudflare HTTPS / WebXR

1. 先在安卓端保留固定端口（默认 `8081`），并记下它当前的局域网 IP。
2. 在 Cloudflare Zero Trust 的 Tunnels 中添加 Published application：Public hostname 选择你的域名，Service URL 填写 `http://<安卓IP>:8081`。
3. Additional application settings 中的 HTTP Host Header 保持空白，不要把公网 `Host` 改成局域网 IP。
4. 在 Access > Applications 中把该域名添加为 Self-hosted 应用，只允许你的账号、邮箱或身份组访问。面向公网时不要跳过这一步。
5. 在 APK 的“可信 HTTPS 外部来源”中填入同一个公网来源，例如 `https://xr.example.com`，然后启动服务器。
6. 头显先通过 Cloudflare Access 登录，再使用该 HTTPS 地址配对。页面处于可信安全上下文且头显浏览器实现 WebXR 时，才会启用“进入沉浸模式”。

Tunnel 需在能访问安卓局域网 IP 的设备上运行。如果路由器重新分配了安卓 IP，需要同步修改 Service URL；建议在路由器为安卓设备保留 DHCP 地址。

## Beta 已实现

- Android Storage Access Framework 文件夹授权；不申请管理整机文件的高危权限。
- 持久化文件夹授权、手动重新扫描入口，及大小已知、可 seek 视频的媒体索引。
- Android `connectedDevice` 前台服务，仅绑定当前局域网 IPv4 与用户设定的固定端口；网络地址变化后安全停止。
- 内嵌的同源 HTTP/1.1 服务器，支持 `GET` / `HEAD`、单段 `Range`、`If-Range`、`206` 和 `416`。
- 每次启动重新生成六位配对码；配对尝试限速，会话仅存内存，Cookie 为 `HttpOnly` 且 `SameSite=Strict`。
- 媒体不暴露 `content://` URI 或文件系统路径，API 与媒体流默认要求已配对会话。
- 头显网页内置媒体库、搜索、原片播放、续播进度、VR180 / VR360 和 SBS / TB 立体渲染。
- 网页、API 和视频位于同一来源，不需要 CORS，并对 `Host` 与写请求 `Origin` 做精确检查。
- CI 构建把 commit SHA、构建时间和发布渠道写入 APK，并由 `/api/health` 与 `/api/server` 返回，便于核对源码与安装包。

## 重要限制

- 当前只做原片直传，没有 FFmpeg 转码、HLS / ABR、超分、AI 增强、网盘或缓存。
- 能否播放 HEVC Main10、HDR、Dolby Vision、MKV 和多声道，取决于头显浏览器、容器和硬件解码能力；服务器不会自动兼容化。
- VR 布局目前从文件名推断：可使用 `vr180` / `180deg`、`vr360` / `360deg`、`sbs` / `hsbs` 或 `tb` / `ou` 等标记；未命中时会按平面单目视频处理。本 Beta 还没有头显端手动布局编辑器。
- 只索引提供已知文件大小且支持随机 seek 的 SAF 文档。云盘、虚拟文档或管道式 Provider 可能被跳过。
- APK 在安卓端仍以 HTTP 提供上游服务。局域网 HTTP 可用于普通浏览器播放，但不是 WebXR 需要的可信安全上下文，也无法防止同一局域网中的流量窃听。
- 要启用沉浸式 WebXR，请让 Cloudflare Tunnel 或其他可信 HTTPS 反向代理指向 `http://<安卓局域网IP>:<设定端口>`，并在 APK 中填入完全相同的 HTTPS 来源。代理必须保留该公网 `Host` 和浏览器 `Origin`；服务器不会信任 `Forwarded` 或 `X-Forwarded-*`。本 Beta 尚未内置 Tunnel 客户端，需在另一台局域网设备或 Android 上的独立环境运行。
- 六位配对码不是公网登录系统；经同一个 Tunnel 进入的连接还可能共享限速来源。公网域名必须由 Cloudflare Access 或等效的反向代理身份验证先行保护。
- 未经 Quest、PICO 或 Vision Pro 真机及 90 分钟浸泡验收，因此 Beta 不作三平台完整兼容性承诺。

## 构建

锁定的构建组合：JDK 17、Gradle 8.13、Android Gradle Plugin 8.13.2、Kotlin 2.3.21、compileSdk / targetSdk 36，minSdk 26。

macOS / Linux：

```bash
./gradlew :app:testDebugUnitTest :app:lintBeta :app:assembleBeta --no-daemon
```

Windows PowerShell：

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintBeta :app:assembleBeta --no-daemon
```

不可调试的 Beta APK 位于 `app/build/outputs/apk/beta/app-beta.apk`。根目录的 `npm run build:android-web` 可以重新生成包含在 APK 中的头显页面。

GitHub Actions 会在 `Android_beta` 分支重新生成并核对内置头显网页，执行 TypeScript、ESLint、Android 单元测试、Lint 和 Beta 构建，再上传 `Localis-Android-Server-beta-<commit>` 产物及 SHA-256 文件，保留 14 天。

当前 CI APK 不可调试，但仍使用临时 Debug 密钥签名，只适合 Beta 验证。建立长期 Beta 或 Release 前，必须改为受保护且持续备份的固定签名密钥。

早期 `Android_beta` 曾发布过包名为 `com.localis.xrplayer` 的错误播放器原型；本服务器使用 `com.localis.xrserver`，两者会并存。安装本版后可手动卸载旧的 Localis Android Player。不同 CI 运行的临时签名也可能无法覆盖安装，遇到签名冲突时需先卸载旧服务器 Beta。
