# Sub2API EasyPay 配置说明

本文说明如何把本服务配置为 Sub2API 的 EasyPay 支付服务商。

## 1. 本项目配置

在服务器 `.env` 中填写：

```dotenv
EASYPAY_ENABLED=true
EASYPAY_PID=10001
EASYPAY_KEY=请替换为随机共享密钥
RECHARGE_AMOUNTS=10,20,50,100,200,500
EASYPAY_QR_CONTENTS={"10":"https://qr.alipay.com/10元经营码内容","20":"https://qr.alipay.com/20元经营码内容","50":"https://qr.alipay.com/50元经营码内容","100":"https://qr.alipay.com/100元经营码内容","200":"https://qr.alipay.com/200元经营码内容","500":"https://qr.alipay.com/500元经营码内容"}
```

`EASYPAY_QR_CONTENTS` 是金额到二维码内容的 JSON 映射。键是人民币元金额，值必须是支付宝经营码图片中实际编码的文本内容，例如 `https://qr.alipay.com/...`。它必须与 `RECHARGE_AMOUNTS` 完全一致：每个允许金额各有一张固定金额经营码，不能遗漏或添加未允许的金额。

不能填写二维码图片 URL，否则 Sub2API 会把图片 URL 再编码成一个“下载二维码图片”的二维码。原始图片仍可单独用于人工核对，但不会作为 EasyPay 的 `qrcode` 字段返回。旧的 `EASYPAY_QR_CONTENT` 仍可使用，但只会为所有金额返回同一张二维码，不适合固定金额经营码。

修改后重启：

```bash
docker compose up -d --build
```

## 2. Sub2API 后台配置

进入：

```text
设置 → 支付设置
```

先开启支付，再在“服务商管理”中新增 `EasyPay` 服务商。

填写：

```text
PID：与 EASYPAY_PID 完全一致，例如 10001
PKey：与 EASYPAY_KEY 完全一致
API 地址：https://你的支付域名
支付宝通道 ID：留空；若必填则填写 alipay
微信通道 ID：留空
```

API 地址只填写服务根域名，不要填写 `/mapi.php` 或 `/api.php`。本服务会自动提供这些路径。

然后把前台“支付宝”支付来源选择为“EasyPay 支付宝”。不要同时启用支付宝官方 Provider 和本 EasyPay Provider 作为同一个入口。

## 3. 回调配置

不需要手工填写 `notify_url` 或 `return_url`。Sub2API 创建订单时会把回调地址传给本服务，本服务在管理员确认后向该地址发送签名成功通知。

本项目的 `/notify.php` 是给你自己的到账检测组件调用的，不是让 Sub2API 回调的地址。

## 4. 实际流程

```text
Sub2API 创建订单
→ 本服务 /mapi.php 按订单金额返回对应的支付宝经营码
→ 用户扫码付款
→ 管理员在本项目 /admin 确认到账
→ 本服务回调 Sub2API
→ Sub2API 给用户余额充值
```

当前实现仍然以人工确认到账为准。如果要自动到账，需要独立的到账检测组件在确认金额和订单匹配后调用：

```text
POST https://你的支付域名/notify.php
```

请求必须包含合法签名、`out_trade_no`、`trade_no`、`money` 和 `trade_status=SUCCESS`。

## 5. 联调检查

1. 访问 `https://你的支付域名/health`，确认返回 `{"ok":true}`。
2. 在 Sub2API 创建一笔测试充值，确认能显示二维码。
3. 检查本服务管理员后台是否出现 `easypay_alipay` 订单。
4. 管理员确认后，检查 Sub2API webhook 是否收到 `SUCCESS` 通知。
5. 确认用户余额只增加一次。
