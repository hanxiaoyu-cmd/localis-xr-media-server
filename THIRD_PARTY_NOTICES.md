# Third-party notices

Localis 本体与下列第三方组件是可分离的作品。第三方许可证只适用于对应组件；精确版本以 `package-lock.json` 和发行包内文件为准。

## FFmpeg 6.1.1 Windows binary

Windows 发行包通过 `ffmpeg-static@5.3.0` 携带 `FFmpeg 6.1.1-essentials_build-www.gyan.dev`。该二进制启用了 GPL 组件（包括 libx264）并以 GNU GPL version 3 发布。

- Binary package: https://github.com/eugeneware/ffmpeg-static/tree/5.3.0
- Exact FFmpeg source commit: https://github.com/FFmpeg/FFmpeg/tree/e38092ef93
- Build provider: https://www.gyan.dev/ffmpeg/builds/
- License text: `node_modules/ffmpeg-static/ffmpeg.exe.LICENSE` in the packaged application
- Build configuration: `node_modules/ffmpeg-static/ffmpeg.exe.README` in the packaged application

Localis 通过独立子进程调用 FFmpeg，没有把 FFmpeg 代码链接进 Localis 本体。无论这种边界如何解释，发布者仍完整保留并履行 FFmpeg 二进制自身的 GPLv3 义务。

## ffprobe 4.0.2 Windows binary

Windows 发行包通过 `ffprobe-static@3.1.0` 携带 FFmpeg 项目的 ffprobe 4.0.2 GPLv3 Windows 二进制。

- Wrapper package: https://github.com/joshwnj/ffprobe-static/tree/v3.1.0
- Corresponding FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n4.0.2
- FFmpeg GPLv3 text: https://github.com/FFmpeg/FFmpeg/blob/n4.0.2/COPYING.GPLv3

`ffprobe-static` JavaScript wrapper采用 MIT License；发行包保留其 `LICENSE`。ffprobe 二进制的 GPLv3 义务独立存在。

## npm runtime dependencies

主要运行时依赖包括 Electron、React、Three.js、hls.js、Express、Vinext、ACME Client、http-proxy、qrcode、ffmpeg-static 与 ffprobe-static。完整直接及传递依赖、版本与完整性摘要以 `package-lock.json` 为准。发行包保留各 npm 包自带的许可证文件。

## Cloud connectors

- Localis 只实现标准 WebDAV 客户端兼容层，不复制、链接或捆绑 OpenList。OpenList 是独立的 AGPL-3.0 项目。
- Localis 不在仓库或 Windows 包内预装夸克官方网盘组件。只有用户在电脑端明确点击安装后，Localis 才把官方组件下载到系统应用数据目录。该组件采用其上游仓库声明的许可证。
- 百度网盘接入使用用户自行申请并通过审核的开放平台应用身份；应用密钥不会随桌面发行包分发。

## Super resolution description

Localis 当前电脑端超分由 FFmpeg 的空间缩放、环绕采样与锐化滤镜组成，没有复制 AMD FSR、NVIDIA DLSS、Real-ESRGAN 或其他神经超分项目源码，也不应描述为这些项目的认证实现或 AI 超分。
