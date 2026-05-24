# ST Proxy

ST Proxy 是一个用于 SillyTavern 的 Node.js 反代项目。它提供管理后台、渠道管理、模型别名、自动轮询切换和使用记录，可部署在 Docker 中。

本项目由 AI 辅助开发，难免有不足之处，欢迎提交 issue 和建议。

## 功能

* 使用同一个 API Key 访问管理后台和 SillyTavern 反代接口。

* 在后台添加渠道：API 地址、密钥、备注、服务商链接。

* 从渠道 API 获取模型列表，选择要启用的模型，并给模型设置别名。

* 每个渠道可单独选择是否向上游透传 `temperature`、`top_p`、`top_k`、`frequency_penalty`、`presence_penalty`。

* 请求时按模型别名匹配渠道，同一别名存在多个渠道时自动轮询。

* 当前渠道失败时自动尝试下一个匹配渠道。

* 记录使用时间、模型、源模型、渠道和成功状态。

* 支持 OpenAI 兼容接口流式透传；Claude/Gemini 原生渠道支持流式转换。

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
docker build -t st-proxy .
docker run -d \
  --name st-proxy \
  -p 3000:3000 \
  -v st-proxy-data:/app/data \
  -e PROXY_API_KEY=pwd \
  st-proxy
```

项目配置放在根目录的 `config.json`：

```json
{
  "port": 3000,
  "apiKey": "pwd"
}
```

默认 API Key 是 `pwd`。如果服务会暴露到本机以外，请修改 `apiKey`。

使用 Docker Compose 时，先在 shell 中设置 `PROXY_API_KEY`，或从 `.env.example` 复制一份本地 `.env` 文件。

打开：

```text
http://localhost:3000/admin
```

用 `config.json` 里的 `apiKey` 登录后台。如果 `config.json` 不存在，服务会在根目录自动生成 `config.json`，并在启动日志中打印 key。

## SillyTavern 配置

在 SillyTavern 中选择 OpenAI 兼容接口：

```text
Base URL: http://你的服务器:3000/v1
```

后台中启用的模型别名会出现在 `/v1/models`。例如两个渠道都有 `claude-opus-4-7`，可以把它们的别名都设置为 `claude-opus-4-7`，SillyTavern 请求 `claude-opus-4-7` 时会在这些渠道之间轮询。

## 渠道格式

后台支持四种格式选项：

* 自动识别：根据 API 地址识别 Gemini 和 Anthropic，其他默认为 OpenAI 兼容。

* OpenAI 兼容：使用 Bearer token 调用 `/v1/models` 和 `/v1/chat/completions`。

OpenAI 兼容渠道支持流式透传。Claude/Gemini 原生流式响应会转换成 OpenAI 兼容的 SSE chunk。

每个渠道都有“参数透传”配置。关闭某一项后，代理会在转发到该渠道前从请求体中移除对应参数；旧渠道没有该配置时，默认保持全部透传。

## 配置文件

主配置文件放在根目录：

```text
config.json
```

字段说明：

* `port`：HTTP 服务端口。

* `apiKey`：管理后台和 SillyTavern 请求共用的认证 key。

## 数据目录

数据默认保存在：

```text
data/
```

Docker 中对应：

```text
/app/data
```

包含：

* `db.json`：渠道配置、模型别名和使用记录。

## API

管理后台 API 需要：

```http
Authorization: Bearer <config.json 里的 apiKey>
```

常用接口：

* `GET /api/channels`

* `POST /api/channels`

* `POST /api/channels/:id/fetch-models`

* `PUT /api/channels/:id/models`

* `DELETE /api/channels/:id`

* `GET /api/usage`

* `GET /v1/models`

* `POST /v1/chat/completions`

## 注意事项

* 如果服务会暴露到公网或多人网络，请修改 `config.json` 中的 `apiKey`。

* 建议把 `data` 挂载为 Docker volume，避免容器重建后配置丢失。

* 使用记录最多保留最近 1000 条。

* 每个渠道可选择流式或非流式，默认流式。酒馆请求非流式时会强制渠道非流式；酒馆请求流式但渠道选择非流式时，会等待渠道完整返回后再用 OpenAI 兼容 SSE 一次性发给酒馆。

* 不同服务商的原生流式格式不同，Claude/Gemini 流式响应会转换成 OpenAI 兼容的 SSE 文本 chunk。
