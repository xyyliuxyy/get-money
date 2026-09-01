# EasyPay 兼容层设计

## 目标

在保留现有人工支付宝充值流程的基础上，为本项目增加 EasyPay 兼容层，让 Sub2API 可以通过标准支付服务商接口创建订单、展示个人支付宝二维码、查询状态，并在管理员确认到账后接收成功通知。

本阶段不抓取或自动化操作支付宝页面，订单仍以管理员人工确认到账为准。

## 方案

采用双模式并行架构：

- 现有 `/pay` 用户页面和管理员审核流程继续支持 `alipay_manual`。
- 新增 EasyPay 路由，使用独立的 `easypay` 支付方式。
- 管理员确认 EasyPay 订单后，调用订单记录中的 `notify_url` 通知 Sub2API；旧人工订单继续调用现有 Sub2API Admin API。
- 通过订单支付方式分流，禁止同一订单同时执行两种充值动作。

## EasyPay 接口

### 创建订单：`POST /mapi.php`

接收 EasyPay 的 `pid`、`type`、`out_trade_no`、`notify_url`、`return_url`、`name`、`money`、`param`、`sign` 和 `sign_type` 等字段。

服务端将校验共享密钥签名、PID、支付类型和金额白名单，使用 `out_trade_no` 做幂等键创建本地订单。重复请求必须返回同一支付订单，不得创建重复记录。

成功响应至少包含：

```json
{
  "code": 1,
  "msg": "success",
  "trade_no": "本地支付订单号",
  "qrcode": "二维码地址或二维码内容"
}
```

### 查询订单：`POST /api.php`

支持 `act=order`，根据 `pid`、`key` 和 `out_trade_no` 验证请求并返回订单状态。状态映射如下：

| 本地状态 | EasyPay 状态 |
| --- | --- |
| `awaiting_payment`、`pending_review`、`processing` | `WAITING` |
| `approved` | `SUCCESS` |
| `rejected`、`expired`、`recharge_failed` | `FAILED` |

### 异步通知：`GET/POST /notify.php`

通知接口验证签名、订单号、金额和交易号，记录通知幂等状态，然后向订单保存的 `notify_url` 发送成功通知。重复通知必须返回成功响应但不能重复触发业务处理。

## 数据模型

在 `orders` 表增加 EasyPay 外部订单字段：

- `external_order_no`：Sub2API 的 `out_trade_no`，唯一
- `notify_url`：成功通知地址
- `return_url`：可选的支付完成跳转地址
- `external_trade_no`：外部交易号
- `callback_status`：通知状态
- `callback_attempts`：通知尝试次数

现有 `trade_no` 继续保存用户提交的支付宝交易号，避免破坏旧人工订单。EasyPay 订单使用 `payment_method = 'easypay_alipay'`。

## 二维码访问

现有 `/assets/alipay-qr.png` 需要本地用户 Session，不适合 Sub2API 的支付页。EasyPay 创建接口将返回可被外部页面访问的绝对二维码地址，或配置的二维码内容/Data URL。该访问方式不包含任何 Sub2API 管理密钥。

## 管理员流程

管理员审核通过时按 `payment_method` 分流：

- `alipay_manual`：调用现有 `create-and-redeem` 接口。
- `easypay_alipay`：更新本地订单为 `approved`，然后发送 EasyPay 成功通知。

通知失败时保留可重试状态和错误信息，不重复执行余额充值。管理员重试只重发通知，不改变已经成功的订单语义。

## 安全约束

- EasyPay 使用独立的 `EASYPAY_PID`、`EASYPAY_KEY` 配置。
- 所有外部参数做长度、格式和金额校验。
- 签名比较使用恒定时间比较。
- 创建、查询和通知接口不创建本地用户 Session。
- 不向浏览器、日志或响应暴露 `SUB2API_ADMIN_API_KEY`、Session Secret 或 EasyPay 密钥。
- 保留现有管理员 CSRF、审计日志和限流策略。

## 测试策略

先写失败测试，再实现以下行为：

1. 合法 EasyPay 创建请求返回二维码和订单号。
2. 非法签名、PID、金额和重复订单请求被正确处理。
3. 查询接口正确映射本地状态。
4. 管理员确认 EasyPay 订单后发送签名通知。
5. 重复通知不会重复处理。
6. 通知失败可安全重试。
7. 原有人工充值、管理员审核和并发充值测试继续通过。

