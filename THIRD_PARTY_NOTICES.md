# Third-party notices

Localis 的当前电脑端超分由用户电脑上的 FFmpeg `zscale`、`cas` 与标准 H.264 编码器组合实现，没有复制 AMD FSR、NVIDIA DLSS、Real-ESRGAN 或其他神经超分项目的源代码，也不应被描述为这些项目的认证实现或 AI 超分。

本项目通过 npm 使用多个开源依赖。主要运行时依赖包括 React、Three.js、Hls.js、Express、Vinext、ACME Client、http-proxy 和 qrcode；其准确版本和完整传递依赖以 `package-lock.json` 为准。发布者应保留各依赖包自带的许可证文本。当前依赖审计显示运行时直接依赖采用 MIT、Apache-2.0 等许可，具体义务仍以各包内许可证为准。

Localis 调用用户电脑上已有的 FFmpeg/ffprobe，不在本仓库中分发 FFmpeg 二进制。FFmpeg 构建的许可取决于其编译选项；包含 libx264 的常见 Windows full build 通常涉及 GPL 义务。若未来随 Localis 分发 FFmpeg，发布者必须单独完成许可证、源代码提供和通知义务。

Localis 只实现标准 WebDAV 客户端兼容层，不复制、链接或捆绑 OpenList。OpenList 是独立的 AGPL-3.0 项目，由选择该实验性云盘桥接方式的用户自行安装和维护；若未来捆绑、修改或分发 OpenList，发布者必须另行履行 AGPL-3.0 义务。夸克 OpenList 驱动使用非官方接口，不属于 Localis 或夸克的官方集成。

Localis 仓库不捆绑夸克官方网盘 Skill/CLI。只有用户在电脑端明确点击“安装夸克官方组件”后，Localis 才会从夸克官方 GitHub 仓库下载组件并运行其官方安装器；动态运行时位于仓库外的系统应用数据目录。该官方仓库采用 Apache-2.0，发布者和再分发者仍应保留其许可证与通知。Localis 仅调用官方公开的浏览器授权、搜索与完整文件下载命令，不把它描述成 Windows Range 流媒体 SDK，也不启用 OpenList QuarkTV 当前通过第三方明文 HTTP 服务交换登录票据的扫码链路。

项目本身目前没有开源许可证。没有明确许可证并不等于允许复制、修改或再发布；在许可证决定完成前，GitHub 仓库应保持私有。
