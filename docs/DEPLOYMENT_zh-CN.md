# 人工充值服务部署与 Sub2API 配置

## 结论

需要把本人工充值服务部署到一台可被普通用户访问的服务器。最简单的方案是部署在现有 Sub2API 服务器上，作为独立 Docker 服务运行；它不修改 Sub2API 代码、数据库或余额表。

也可以部署在另一台服务器，但必须有独立公网域名和 HTTPS。

推荐域名规划：

```text
Sub2API: https://home.niuniu-ai.top
人工充值: https://pay.niuniu-ai.top
```

不要把 `localhost:3002` 配给生产用户。它只适用于充值服务所在电脑上的本地联调。

## 一、准备域名与服务器

1. 为充值服务准备域名，例如 `pay.niuniu-ai.top`。
2. 在 DNS 添加 A/AAAA 记录，指向部署服务器公网 IP。
3. 服务器需要安装 Docker Engine、Docker Compose 插件和 Nginx 或 Caddy。
4. 防火墙仅开放 `80`、`443`；不要把容器 `3000` 端口直接暴露到公网。

同机部署不会与 Sub2API 冲突：Sub2API 和人工充值服务使用不同容器与本地端口，Nginx/Caddy 按域名转发。

## 二、部署人工充值服务

将本项目上传或 clone 到服务器，例如：

```bash
git clone <your-repository-url> /opt/manual-pay
cd /opt/manual-pay
mkdir -p data
cp .env.example .env
```

生成会话密钥和管理员密码 hash：

```bash
openssl rand -hex 32
node -e "require('bcryptjs').hash('change-this-password', 12).then(console.log)"
```

将个人支付宝收款二维码保存为：

```text
/opt/manual-pay/data/alipay-qr.png
```

二维码只由已验证的用户会话访问，不要放入 Git。

## 三、充值服务 `.env` 配置

编辑 `/opt/manual-pay/.env`。生产示例：

```env
NODE_ENV=production
PORT=3000

BASE_URL=https://pay.niuniu-ai.top
TRUST_PROXY_HOPS=1

SUB2API_BASE_URL=https://home.niuniu-ai.top
SUB2API_ADMIN_API_KEY=admin_replace_with_real_key

ALIPAY_QR_IMAGE=/app/data/alipay-qr.png
RECHARGE_AMOUNTS=10,20,50,100,200
BALANCE_PER_CNY=1

MAX_PENDING_ORDERS_PER_USER=3
ORDER_EXPIRE_HOURS=24
PROCESSING_STALE_MINUTES=15

SESSION_SECRET=replace_with_openssl_output
SESSION_TTL_HOURS=12

ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=replace_with_bcrypt_hash

DATABASE_PATH=/app/data/manual-pay.sqlite

USER_AUTH_RATE_LIMIT_WINDOW_MS=3600000
USER_AUTH_RATE_LIMIT_MAX=10
ORDER_CREATE_RATE_LIMIT_WINDOW_MS=3600000
ORDER_CREATE_RATE_LIMIT_MAX=10
ORDER_SUBMIT_RATE_LIMIT_WINDOW_MS=3600000
ORDER_SUBMIT_RATE_LIMIT_MAX=10
ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS=900000
ADMIN_LOGIN_RATE_LIMIT_MAX=5
```

变量说明：

- `BASE_URL`：用户实际访问的充值服务 HTTPS 地址，必须与反向代理域名一致。
- `TRUST_PROXY_HOPS=1`：Nginx/Caddy 位于服务前的一层反向代理时使用。没有反向代理时设为 `0`。
- `SUB2API_BASE_URL`：现有 Sub2API 公开地址。生产优先使用 HTTPS；你的当前地址可填写 `https://home.niuniu-ai.top`，若该站未配置 HTTPS 才临时使用 HTTP。
- `SUB2API_ADMIN_API_KEY`：在 Sub2API 管理端生成的 Admin API Key。只存在服务端 `.env`，绝不写到浏览器、Nginx 配置或 Git。
- `ALIPAY_QR_IMAGE`：Docker 容器内二维码路径。Compose 已将本机 `./data` 挂载到 `/app/data`。
- `RECHARGE_AMOUNTS`：用户可选的固定人民币金额，禁止提供任意金额输入。
- `BALANCE_PER_CNY`：每 1 元实际增加的 Sub2API 余额。
- `ADMIN_USERNAME` 与 `ADMIN_PASSWORD_HASH`：人工充值后台账号，独立于 Sub2API 管理员账号。密码只保留 bcrypt hash。

运行：

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
docker compose logs -f manual-pay
```

SQLite 数据库与二维码都保存在 `./data`，升级前备份：

```bash
sqlite3 data/manual-pay.sqlite ".backup data/manual-pay-backup-$(date +%F).sqlite"
```

## 四、配置 HTTPS 反向代理

Nginx 示例：

```nginx
server {
  listen 80;
  server_name pay.niuniu-ai.top;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name pay.niuniu-ai.top;
  ssl_certificate /etc/letsencrypt/live/pay.niuniu-ai.top/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pay.niuniu-ai.top/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

启用配置后检查并重载：

```bash
nginx -t && systemctl reload nginx
```

使用 Caddy 时只需：

```caddy
pay.niuniu-ai.top {
  reverse_proxy 127.0.0.1:3000
}
```

## 五、Sub2API 需要怎样配置

不需要改 Sub2API 数据库，不需要增加支付回调，不需要修改余额逻辑。

在 Sub2API 管理后台查找以下之一的配置项，具体名称取决于当前版本：

```text
purchase_subscription_url
自定义购买页 URL
用户侧自定义页面 URL
```

将它设置为：

```text
https://pay.niuniu-ai.top/pay
```

Sub2API 会在已登录用户点击“充值/购买”时向该地址追加 `user_id`、`token`、`theme`、`lang`、`ui_mode`。人工充值服务忽略可伪造的 `user_id`，只拿 token 请求：

```text
GET https://home.niuniu-ai.top/api/v1/user/profile
Authorization: Bearer <token>
```

所以普通用户没有额外的充值站用户名密码：先登录 Sub2API，再从 Sub2API 点击充值。

还需要在 Sub2API 管理端生成 Admin API Key，填入充值服务 `.env` 的 `SUB2API_ADMIN_API_KEY`。服务端批准订单时使用官方接口：

```text
POST /api/v1/admin/redeem-codes/create-and-redeem
```

## 六、上线前联调清单

1. 打开 `https://pay.niuniu-ai.top/health`，应返回 `{"ok":true}`。
2. 访问 `https://pay.niuniu-ai.top/admin/login`，使用 `ADMIN_USERNAME` 与对应密码登录。
3. 使用普通测试用户登录 Sub2API，点击“充值/购买”。浏览器应跳转到充值页面，且地址栏跳转后不保留 token。
4. 创建一笔小额测试订单，支付后提交交易号。
5. 管理员在支付宝账单人工核对，再在后台点击“确认到账并充值”。
6. 在 Sub2API 检查该用户余额和兑换记录；不要通过数据库手工改余额。
7. 测试拒绝订单和 `recharge_failed` 的重试。重试必须保留同一个订单和兑换码。

## 七、安全与故障处理

- 生产必须 HTTPS，否则 Secure Cookie 不会安全工作。
- `.env`、二维码、SQLite 数据库必须备份且不得提交 Git。
- 如果批准后显示 Admin API Key 错误，检查 `SUB2API_ADMIN_API_KEY`、`SUB2API_BASE_URL` 和 Sub2API 端的 Key 权限。
- `recharge_failed` 表示已人工确认收款但上游调用失败；在后台点击“重试充值”，不要重新创建订单。
- 不要把个人支付宝二维码伪装成支付宝商户 API；本服务仅支持人工核账。
