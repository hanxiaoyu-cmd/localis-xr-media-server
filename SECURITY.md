# Security policy

Localis 会读取本机媒体路径，并在数据目录保存配对密钥、证书私钥、播放进度和转码缓存。不要把 `.localis/`、`.env`、证书、私钥、Cloudflare Token、诊断文件或个人媒体提交到 GitHub。

提交安全问题时，请优先使用 GitHub 仓库的私有 Security Advisory，并提供可复现步骤、受影响版本和已脱敏日志。不要在公开 Issue 中附带真实媒体路径、局域网拓扑、配对码或任何密钥。

如果密钥、Token 或证书曾被误提交，应先在对应服务端撤销/轮换，再从 Git 历史中清理；仅删除最新提交中的文件并不能使旧秘密失效。
