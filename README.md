# Z.AI OpenAI Proxy

A Cloudflare Worker that proxies OpenAI-compatible API requests to Z.AI, allowing you to use Z.AI models (like GLM 4.7) with any OpenAI SDK client.

## Features

- 🔄 **OpenAI Compatible** - Works with any OpenAI SDK client
- 🚀 **Default Model** - Uses GLM 4.7 as the default model
- 📡 **Streaming Support** - Full support for streaming responses
- 🌐 **CORS Enabled** - Works from browser applications
- 🔐 **Secure** - API key stored as Cloudflare secret

## Rate Limits (Lite Coding Plan)

- ~120 prompts per 5 hours
- Refreshes every 5 hours
- $3/month first billing cycle, then $6/month

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Your Z.AI API Key

```bash
npx wrangler secret put ZAI_API_KEY
# Enter your Z.AI API key when prompted
```

### 3. Deploy

```bash
npm run deploy
```

## Usage

Once deployed, use your worker URL as the OpenAI base URL:

### Python Example

```python
from openai import OpenAI

client = OpenAI(
    api_key="any-value",  # Not used, but required by SDK
    base_url="https://zai-openai-proxy.<your-subdomain>.workers.dev/v1"
)

response = client.chat.completions.create(
    model="glm-4.7",  # Optional, defaults to glm-4.7
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### cURL Example

```bash
curl https://zai-openai-proxy.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` or `/health` | Health check |
| `/v1/models` | List available models |
| `/v1/chat/completions` | Chat completions (proxied to Z.AI) |

## Local Development

```bash
npm run dev
```

Then test at `http://localhost:8787`
