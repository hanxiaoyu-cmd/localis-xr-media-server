# Third-party notices

Localis 的空间超分着色器是本项目独立实现的边缘感知空间重建与自适应锐化，没有复制 AMD FSR、NVIDIA DLSS 或其他超分项目的源代码，也不应被描述为这些项目的认证实现。

本项目通过 npm 使用多个开源依赖。主要运行时依赖包括 React、Three.js、Hls.js、Express、Vinext、ACME Client、http-proxy 和 qrcode；其准确版本和完整传递依赖以 `package-lock.json` 为准。发布者应保留各依赖包自带的许可证文本。当前依赖审计显示运行时直接依赖采用 MIT、Apache-2.0 等许可，具体义务仍以各包内许可证为准。

Localis 调用用户电脑上已有的 FFmpeg/ffprobe，不在本仓库中分发 FFmpeg 二进制。FFmpeg 构建的许可取决于其编译选项；包含 libx264 的常见 Windows full build 通常涉及 GPL 义务。若未来随 Localis 分发 FFmpeg，发布者必须单独完成许可证、源代码提供和通知义务。

项目本身目前没有开源许可证。没有明确许可证并不等于允许复制、修改或再发布；在许可证决定完成前，GitHub 仓库应保持私有。
