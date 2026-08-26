# Changelog

Localis 的重要变更记录在这里。版本遵循 [Semantic Versioning](https://semver.org/)，发布日期使用北京时间对应的自然日。

## [0.4.1] - 2026-08-26

### 修复

- Windows 打包命令显式禁用 electron-builder 的标签隐式发布，确保它只生成安装版与便携版，GitHub Release 仍由后续受控步骤统一校验并上传。
- `v0.4.0` 标签因上述自动化问题没有创建 GitHub Release；`v0.4.1` 是包含下方全部 0.4 功能的首个公开安装包版本。

## [0.4.0] - 2026-08-26

### 新增

- 在 Localis 页面内提供与主界面一致的媒体文件夹浏览器，支持快捷位置、磁盘、面包屑、手动路径和无障碍键盘操作，不再依赖隐藏到桌面的 Windows 原生选择窗口。
- 建立 HDR10、HLG、10-bit SDR、杜比视界与未知色彩信号的保守媒体分类，以及按设备、浏览器和精确媒体身份绑定的人工显示确认。
- 增加原片、兼容 HLS、电脑端超分与 AI 清晰的实际播放路径标签和诊断信息。
- 将 Real-ESRGAN NCNN Vulkan 运行时与模型纳入 Windows 桌面包；AI 清晰改为完整预处理并原子发布播放清单。
- 建立可追溯 Windows CI / Release 流程，统一 Web、服务端、Electron 和诊断文件中的 commit SHA 与 `buildId`，发布安装版、便携版、CycloneDX SBOM 和 SHA-256 校验文件。

### 改进

- HEVC Main/Main10、HDR 和高位深内容优先依据真实浏览器能力与人工确认决定是否原片播放，证据不足时安全回退到电脑端兼容流。
- HDR 兼容流增加色调映射、降位深与抖动策略；杜比视界和未知色彩内容不再被误标为已保真 HDR。
- 强化 Windows 媒体工具验证、构建产物身份检查、长片 seek、HLS 分流、缓存与播放错误恢复。
- 更新测试、真机验收、发布流程和后续路线图文档。

### 安全与边界

- 文件夹浏览接口只允许已配对的本机回环请求，只返回目录，并拒绝相对路径、文件与符号链接祖先。
- Vision Pro、Quest、PICO 的真实设备兼容、HDR 观感、90 分钟稳定性和真实网盘账号闭环仍需按验收清单完成；本版本不将自动化结果宣传为真机认证。
- Windows 安装包尚未提供商业代码签名，首次运行可能出现 SmartScreen 提示；请从 GitHub Releases 下载并核对 SHA-256。

[0.4.1]: https://github.com/hanxiaoyu-cmd/localis-xr-media-server/releases/tag/v0.4.1
[0.4.0]: https://github.com/hanxiaoyu-cmd/localis-xr-media-server/tree/v0.4.0
