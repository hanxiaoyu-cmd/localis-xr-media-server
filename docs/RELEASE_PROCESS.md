# Localis 构建与发布流程

Localis 的 Windows 构建使用同一个公开构建身份贯穿浏览器资源、媒体服务 bundle、Electron 载荷与诊断文件。该身份用于发现源码、页面和 EXE 混用；它不是代码签名或供应链证明的替代品。

## 持续集成

`CI` 工作流在拉取请求、`main` 推送和手动触发时使用 Windows runner 执行：

1. `npm ci`
2. ESLint、TypeScript 和全部硬件无关测试；真实 NCNN/Vulkan AI 执行保留给有兼容 GPU 的 Windows 验收机
3. 生产 Web 构建与桌面服务构建
4. 构建元数据校验
5. 前端与服务端编译产物身份一致性校验

受保护分支要求的检查名称为 GitHub 实际创建的 `Windows verification`；配置分支保护时必须从一次真实运行读取检查名称和 Actions App ID，不能只依据本文猜测。

`main` 当前要求通过拉取请求合并、分支保持最新、`Windows verification` 成功且讨论全部解决；规则同时约束管理员，并禁止强推和删除。仓库 Actions 策略只允许 GitHub 官方 Action，且所有 `uses:` 引用必须固定到完整 commit SHA。

## 构建身份

`npm run build:metadata` 原子生成 `desktop/build/build-metadata.json`，公开字段固定为：

- `schemaVersion`
- `buildId`
- `version`
- `commitSha` / `commitShortSha`
- `buildTime`
- `dirty`
- `channel`

默认 `buildTime` 来自 Git commit 时间，同一提交不会因重跑而获得新的身份。发布构建必须是干净工作区，且 `package.json`、`package-lock.json`、Tag 三者版本一致。

构建身份只生成一次。Web 构建把同一 JSON 编译进客户端；esbuild 把它编译进媒体服务；Electron 再携带只读 JSON。桌面端启动时会比较应用版本、载荷身份与 `/api/health` 身份，不一致时拒绝继续启动。播放器也比较客户端和服务端 `buildId`，只自动刷新一次，仍不一致时显示可操作错误并写入诊断。

## 创建 Release

1. 通过拉取请求把已通过 CI 的代码合入 `main`。
2. 同时更新 `package.json` 与 `package-lock.json` 的版本并再次通过 CI。
3. 在 `main` 对应提交创建并推送唯一的 `v<version>` Tag。
4. `Release` 工作流会验证 Tag、硬件无关回归、Windows 安装版/便携版、打包载荷、无界面启动后的运行时身份、CycloneDX SBOM 与 SHA-256；真实 AI 推理仍须在有兼容 Vulkan GPU 的验收机执行。
5. 如存在 `docs/releases/v<version>.md`，工作流将其作为人工整理的 Release Notes；否则使用 GitHub 自动生成说明。
6. 工作流创建 GitHub Release；若同名 Release 已存在则失败，不覆盖已经发布的资产。

Release 包含四个资产：安装版、便携版、CycloneDX SBOM 和 `SHA256SUMS.txt`。发布后应下载资产重新计算 SHA-256，并与校验文件比对。

当前流程保证可追溯的构建身份和不可覆盖的已发布资产，但尚未宣称安装器达到逐字节可复现，也尚未提供商业代码签名。对外发布时必须继续保留 SmartScreen 提示与 SHA-256 核对说明。
