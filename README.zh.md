# dsh-web-search-tavily

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@sunaookaminya/dsh-web-search-tavily)](https://www.npmjs.com/package/@sunaookaminya/dsh-web-search-tavily)
[![license](https://img.shields.io/npm/l/@sunaookaminya/dsh-web-search-tavily)](LICENSE)

基于 [Tavily](https://tavily.com) 的搜索提供方，挂在 DeepSeek Harness（DSH）的 web 能力接缝（`ctx.web`）上：内置的 `web_search` 工具改走 Tavily Search API，而不是出厂的 DeepSeek 搜索路由。

- **一个提供方，id 为 `tavily`** — 用 `web.searchProvider` 选中；在「设置 → 网页搜索与获取」里按名字显示。
- **按 Key 计费，每次搜索现取密钥** — 密钥从凭据库读取，轮换 `TAVILY_API_KEY` 后下一次请求即生效，无需重启。
- **零依赖** — 只用 Node 内置能力（`fetch`、`AbortSignal`）；不启浏览器、不额外走模型请求、不消耗模型 token。
- **结果形状贴合接缝** — Tavily 的 `results[]` 映射为 `{ url, title, snippet }`；可选的 `answer` 映射为结果 `content`。

## 前置条件

- 带 `ctx.web` 接缝的 DSH 宿主，Node.js ≥ 18
- Tavily API Key（`tvly-…`）；免费额度每月 1,000 信用点，基础搜索 1 点/次，高级搜索 2 点/次

## 安装

从 npm 装进某个 DSH profile（把 `web` 换成你的 profile 名）：

```sh
dsh plugin --profile web add @sunaookaminya/dsh-web-search-tavily
```

或用本地 checkout：

```sh
dsh plugin --profile web add link:/path/to/dsh-web-search-tavily
```

再把包名加进 profile 的 bundle 列表（`$DSH_HOME/profiles/web/package.json`）：

```json
{
  "dsh": { "profile": { "bundles": [ "...", "@sunaookaminya/dsh-web-search-tavily" ] } }
}
```

bundle 补丁会选中该提供方并挂载插件行。若不想新增 bundle 层，也可以直接在 profile 自己的 `cordis.patch.yml` 里挂载——该 profile 开着 `patchReload: live` 时会热挂载，无需重启：

```yaml
- id: web
  config:
    searchProvider: tavily
    fetchProvider: http
- insert:
    - id: web-search-tavily
      name: '@sunaookaminya/dsh-web-search-tavily'
      config:
        apiKeyEnv: TAVILY_API_KEY
```

注意：`web` 的补丁会**整体替换**该行的 config，不合并——原行里设的每个键都要照抄过来（出厂 profile 里是 `searchProvider` 与 `fetchProvider`）。

### API Key

存进凭据库即可（就是设置页写入的那个文件，带文件监听、改动自动重载）：

```yaml
# $DSH_HOME/.credentials.yaml
refs:
  TAVILY_API_KEY: "tvly-…"
```

没有存值时回退到启动环境与 `.env` 文件。不要把密钥写进 `cordis.patch.yml`。

## 配置项

插件行 config，全部可选：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索现取的凭据 ref。 |
| `apiKey` | — | 直接写死的密钥；不推荐，优先用凭据库。 |
| `baseURL` | `https://api.tavily.com` | 端点；自定义需 `allowCustomBaseURL: true` 且必须是 https。 |
| `allowCustomBaseURL` | `false` | 是否允许非官方端点。 |
| `searchDepth` | `basic` | `basic`、`advanced`、`fast`、`ultra-fast`。 |
| `maxResults` | `5` | 请求未指定时的结果数（1–20）。 |
| `includeAnswer` | `false` | 让 Tavily 生成答案（作为结果 `content` 返回）。 |
| `chunksPerSource` | `3` | 每条来源的摘要分块数，仅高级搜索有效（1–3）。 |
| `timeoutMs` | `20000` | 单次尝试的硬超时；`attempts × timeoutMs` 需小于 `tool-web` 的 `searchTimeoutMs`（60s）。 |
| `attempts` | `2` | 每次搜索的尝试次数（1–4）。只重试连接类失败与 HTTP 502/503/504，带短暂退避——网络抖动时有用。 |

## 验证

```sh
cd dsh-web-search-tavily
TAVILY_API_KEY=tvly-… node verify.mjs "某个查询"
```

它会用一个桩 `ctx.web` 注册提供方并跑一次真实搜索，打印来源。

## 切回其他搜索

把 `web.searchProvider` 改回要用的 id 即可（出厂 DeepSeek Search API 是 `deepseek-search-api`，服务端搜索是 `deepseek-official`）。各提供方的行仍然挂着，只改选择。

## 许可证

[MIT](LICENSE)
