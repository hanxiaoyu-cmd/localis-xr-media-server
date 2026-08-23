# Security policy

Localis 会读取本机媒体路径，并在数据目录保存配对密钥、证书私钥、播放进度、转码缓存和云盘连接。不要把 `.localis/`、`.env`、`cloud-sources.json`、`cloud-secrets.key`、证书、私钥、Cloudflare Token、百度 App Secret/Token、OpenList 密码、诊断文件或个人媒体提交到 GitHub。

云盘连接、断开和凭据配置接口只接受运行 Localis 的电脑本机请求。局域网设备只会收到不透明的媒体 ID；百度 dlink、OAuth Token、OpenList 地址和 Basic Authorization 不会写入浏览器 URL 或 FFmpeg 命令行。云盘凭据采用随机 AES-256-GCM 密钥加密，密文与密钥均放在仓库外的数据目录并尽量限制为当前操作系统用户可读。该设计可以降低配置文件或 Git 误提交造成的泄露，但不能抵御已经取得同一系统账户完整文件访问权的攻击者。

云盘完整文件缓存使用硬字节配额、文件系统可用空间预留、临时文件计数和持久 LRU 清单。达到边界且没有可回收文件时会返回 `507`；删除云盘连接时会同步清理该来源的缓存。不要让两个 Localis 进程共享同一个 `LOCALIS_DATA_DIR`，进程内锁不能协调两个独立进程对同一缓存清单的写入。

夸克直接扫码目前禁用。不要把 OpenList QuarkTV 当前的二维码能力用于真实账号：其实现会通过第三方明文 HTTP 地址交换登录 code/refresh token。高级用户只应在自行完成风险评估后连接已经部署好的本机 OpenList/WebDAV；不要把 5244 端口暴露到局域网，不要在 Localis 中输入夸克 Cookie，也不要给 `localis-reader` 上传、删除或管理权限。Localis 不跟随 WebDAV 文件 GET 的 302 重定向，OpenList 应使用“WebDAV 策略 → 本机代理（Native Proxy）”。

百度二维码登录只从电脑端配置读取应用身份，浏览器提交的 AppKey/SecretKey 字段会被忽略。私人构建可通过 `LOCALIS_BAIDU_APP_KEY`、`LOCALIS_BAIDU_SECRET_KEY` 与 `LOCALIS_BAIDU_APP_FOLDER` 配置自有应用；共享 SecretKey 不能安全地编译进公开桌面程序，公众版本应使用经过百度审核且由发布者控制的 HTTPS 换票服务。断开 Localis 连接后，还应在百度账号的授权管理中撤销该应用。

提交安全问题时，请优先使用 GitHub 仓库的私有 Security Advisory，并提供可复现步骤、受影响版本和已脱敏日志。不要在公开 Issue 中附带真实媒体路径、局域网拓扑、配对码或任何密钥。

如果密钥、Token 或证书曾被误提交，应先在对应服务端撤销/轮换，再从 Git 历史中清理；仅删除最新提交中的文件并不能使旧秘密失效。
