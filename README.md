# Sub2API Manual Pay

完整中文部署、Sub2API 配置和联调说明见 [docs/DEPLOYMENT_zh-CN.md](docs/DEPLOYMENT_zh-CN.md)。

独立的个人支付宝收款码人工审核充值服务。用户身份由 Sub2API token 初始化，管理员人工核对到账后，服务端调用官方 `create-and-redeem` API 充值。它不监听支付宝通知，不抓取支付宝接口，也不修改 Sub2API 数据库。

## Start

1. `cp .env.example .env` 并填写 Sub2API 地址、Admin API Key、会话密钥和 bcrypt 管理员密码哈希。
2. 将个人收款二维码放到 `data/alipay-qr.png`。
3. `docker compose up -d --build`。
4. 用 Nginx 或 Caddy 将 HTTPS 请求反代到 `127.0.0.1:3000`。单层反代设置 `TRUST_PROXY_HOPS=1`。

使用 `node -e "require('bcryptjs').hash('your-password', 12).then(console.log)"` 生成密码哈希。SQLite 数据库和二维码都在 `data/`；备份使用 `sqlite3 data/manual-pay.sqlite ".backup backup.sqlite"`。

## Sub2API Setup

将 Sub2API 的 `purchase_subscription_url` 设置为 `https://pay.example.com/pay`。Sub2API 会传递 token；本服务只以 profile API 验证出的用户 ID 为准。Admin API Key 仅保存在 `.env`，不得进入浏览器、日志或 Git。

## Operations

健康检查为 `/health`。`recharge_failed` 订单可在后台以相同兑换码安全重试，新的 Idempotency-Key 会生成新的尝试。升级前备份 SQLite，随后执行 `docker compose up -d --build`；迁移会自动执行。生产必须配置 HTTPS，以启用安全 Cookie。
