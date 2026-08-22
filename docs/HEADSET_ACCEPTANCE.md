# 头显真机验收清单

目标：Vision Pro、Quest、PICO 端都不安装 Localis App；Vision Pro 也不安装证书或描述文件，只在自带浏览器访问可信局域网 HTTPS 地址。

每次测试记录：设备型号、OS 版本、浏览器版本、电脑/GPU、Wi-Fi 路由器、源文件编码/分辨率/帧率、Localis 诊断信息、截图或录屏。

## 每台设备都要完成

- [ ] 全新浏览器会话打开可信 HTTPS 地址，没有证书警告。
- [ ] 输入启动终端显示的六位码后进入媒体库；未配对 API 返回 401。
- [ ] 全程没有安装 App、证书、描述文件或浏览器扩展。
- [ ] MP4 Range 直放 20 分钟，暂停、恢复、向前/向后拖动各 10 次。
- [ ] AVI/MKV 兼容 HLS 播放 20 分钟，记录首帧时间和 buffering 次数。
- [ ] 中文外挂字幕在网页播放器和 WebXR 中都可读。
- [ ] VR180 SBS LR 左右眼正确、前方居中、背后为暗场。
- [ ] 360 Mono 接缝方向正确，抬头/低头没有颠倒。
- [ ] 手动切换 SBS/TB、LR/RL 和 yaw 后立即生效，退出/重进 XR 仍正确。
- [ ] WebXR 空间按钮可以播放/暂停、±10 秒、退出。
- [ ] 对同一低分辨率片源分别使用“关闭 / 自动 / 高画质 / 仅锐化”，确认切换即时生效、亮度和色相不漂移。
- [ ] 自动模式的诊断输出尺寸符合预期；超出 GPU 纹理预算的源恢复原生播放器且页面不黑屏。
- [ ] VR180 SBS 开启超分后左右眼边界没有颜色串入；VR360 接缝连续，没有被另一眼或纹理另一端污染。
- [ ] 反复进入/退出 XR 10 次，确认普通播放器超分纹理会释放/恢复，控制台没有 `webglcontextlost` 或 framebuffer 错误。
- [ ] 人为或系统触发 GPU context loss 后页面回退原生播放器，并给出可读提示。
- [ ] 待机再唤醒、退出再进入 XR、Wi-Fi 断开 10 秒再恢复后仍可继续。
- [ ] 连续播放 30 分钟，记录丢帧、音画漂移、发热和转码速度。
- [ ] 4K/60 与设备目标最高分辨率各测一个样本；纹理过大时界面给出可诊断信息。

## Vision Pro 额外项

- [ ] Safari `navigator.xr.isSessionSupported('immersive-vr')` 为 true。
- [ ] 目视 + 捏合 transient-pointer 命中空间大按钮；未捏合时不依赖持续 `inputSources[0]`。
- [ ] 沉浸会话内有声音；最低按 visionOS 2.2 / Safari 18.2 验收。
- [ ] 通过 Mac Safari Web Inspector 保存控制台与网络时间线。
- [ ] 自动超分连续播放至少 30 分钟，对比关闭状态记录丢帧、发热、电量和清晰度收益。
- [ ] 4K VR180 SBS 分别使用自动和高画质进入/退出沉浸模式，记录诊断中的源/输出尺寸与降级原因。

## Quest / PICO 额外项

- [ ] 左右控制器 trigger 均可选择按钮，不依赖固定 gamepad 索引。
- [ ] 手势/控制器切换和 `inputsourceschange` 后仍可操作。
- [ ] Chromium Local Network Access 或站点权限没有阻断同源 LAN HTTPS。

## 网络矩阵

- [ ] 普通家庭 Wi-Fi。
- [ ] 开启 DNS rebinding protection 的路由器。
- [ ] Guest Wi-Fi/AP isolation：应明确提示不可达，而不是无限加载。
- [ ] VPN/Private Relay/DoH 开关前后。
- [ ] DHCP 地址变化后重新运行 `npm run tls:provision`，新地址仍被同一通配符证书覆盖。

只有三类设备的必测项均通过，才能对外写“Vision Pro / Quest / PICO 真机兼容”。
