# Codex Responses Proxy

Codex Responses Proxy 是一个面向 Codex 的 OpenAI Responses API 反代服务。它提供管理后台、渠道管理、模型别名、渠道轮询和使用记录。

这个分支专用于 Codex API，不再兼容 SillyTavern，不再暴露 `/v1/chat/completions` 或 `/v1/completions`。

## 功能

* 使用同一个 API Key 访问管理后台和 Codex 反代接口。
* 在后台添加 Responses-compatible 渠道：API 地址、密钥、备注、服务商链接。
* 从渠道 API 获取模型列表，选择要启用的模型，并给模型设置别名。
* 请求时按模型别名匹配渠道，同一别名存在多个渠道时自动轮询。
* 当前渠道失败时自动尝试下一个匹配渠道。
* 记录使用时间、模型、源模型、渠道和成功状态。
* 支持 OpenAI Responses API 非流式和流式 SSE 透传。

## 快速开始

macOS / Linux：

```bash
./start.sh
```

Windows：

```bat
start.bat
```

Docker：

```bash
docker build -t codex-responses-proxy .
docker run -d \
  --name codex-responses-proxy \
  -p 8880:8880 \
  -v codex-responses-proxy-data:/app/data \
  codex-responses-proxy
```

项目配置放在根目录的 `config.json`：

```json
{
  "port": 8880,
  "apiKey": "pwd"
}
```

默认 API Key 是 `pwd`。如果服务会暴露到本机以外，请修改 `apiKey`。

打开管理后台：

```text
http://localhost:8880/admin
```

## Codex 配置

在 `~/.codex/config.toml` 中添加自定义 provider：

```toml
model = "你的模型别名"
model_provider = "codex_proxy"

[model_providers.codex_proxy]
name = "Codex Responses Proxy"
base_url = "http://127.0.0.1:8880/v1"
env_key = "CODEX_PROXY_API_KEY"
wire_api = "responses"
```

设置环境变量：

```bash
export CODEX_PROXY_API_KEY="pwd"
```

后台中启用的模型别名会出现在 `/v1/models`。Codex 请求某个模型别名时，本服务会把它映射到渠道里的真实模型名。

## 渠道要求

渠道必须支持 OpenAI Responses API：

```text
GET  /v1/models
POST /v1/responses
```

本服务使用 Bearer token 调用上游渠道。

## API

管理后台 API 和 Codex 反代 API 都需要：

```http
Authorization: Bearer <config.json 里的 apiKey>
```

常用接口：

* `GET /api/channels`
* `POST /api/channels`
* `POST /api/channels/:id/fetch-models`
* `POST /api/channels/:id/test`
* `PUT /api/channels/:id/models`
* `DELETE /api/channels/:id`
* `GET /api/usage`
* `GET /v1/models`
* `POST /v1/responses`

## 数据目录

数据默认保存在：

```text
data/
```

包含：

* `db.json`：渠道配置、模型别名和使用记录。

## 注意事项

* 本分支只做 Responses API 透传和模型别名映射，不做 Chat Completions 到 Responses 的协议转换。
* 如果上游只支持 `/v1/chat/completions`，不能作为本分支的渠道使用。
* 使用记录最多保留最近 1000 条。
