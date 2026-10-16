# kojo-market-worker

口上市场**发布后端**（Cloudflare Worker）。给 kojo-editor 的市场消费侧补上「一键上传」：

```
编辑器 ──POST /device-token──▶ 领设备 token（存 localStorage）
编辑器 ──POST /publish (zip)──▶ Worker 结构校验（schema/防穿越/清单对账，零全量解压）
                              ├─ 通过 → R2 待审区 pending/<id>-<version>-<ts>.zip(+.json)
                              ├─       → GitHub 注册表仓自动开 PR（免费档先只带 pack.json，见下）
                              └─ 拒绝 → { rejected: { code, message } }（机器码进日志，作者只看人话）
维护者在 GitHub 网页 merge PR ──▶ CI validate → 打 release zip → 推 gh-pages index.json（权威索引）
        └─(webhook/cron)──▶ Worker 把 pending/ 归档进 packs/ 并把权威索引镜像进 R2
```

- **本仓与编辑器仓库零代码耦合**：schema 常量/判据只做字节级对齐（真源 = kojo-editor `packages/plugin-api/src/market.ts` + 注册表仓 `scripts/market.mjs` 的 CI 判据），不互相 import。
- 校验判据：schema 版本、kind/id/version 形态、`redistribute===true`（CI 同款硬闸）、未知字段拒、路径 `files/` 前缀 + 穿越（`../`/绝对/盘符/反斜杠）零容忍 + 深度 ≤12 + 单路径 ≤512 B、条目 ≤5000、解压总量 ≤128 MiB、zip 本体 ≤99 MB（上传硬限，见下节）、清单↔zip 双向对账（path 集合与 bytes 逐条相等）。防穿越在**解压前**的中央目录预扫完成（zip 炸弹不给 inflate 机会）。
- zip 解析用 **fflate**（仅 `inflateSync`）：纯 JS 零依赖（不碰 Node API，Workers 原生可跑）、中央目录解析手写（O(条目数) 而非 O(字节)）、只对 `pack.json` 局部解出（`{ out }` 缓冲钉死 usize，解压炸弹截断不给 OOM）、~8 KB、维护活跃。

## 免费档方案（结构级校验的取舍）

CF Workers **免费计划**每次调用只有 10 ms CPU：对 99 MB 包体做全量解压、逐文件 sha256 重算、任何对包体的逐字节循环都必然超线。发布链路因此按数据分层：

- **上传通道**：硬上限 **99_000_000 字节（十进制 99 MB）**——CF 免费档请求体边缘上限是 100,000,000 字节，99 MiB≈103.8 MB 会被边缘直接 413（Worker 代码根本收不到），99_000_000 留 1 MB 余量。请求必须带 `Content-Length`（缺失/分块传输 → 411 先行拒因，不收包）；流式落 R2 暂存、超限即中止——中央目录在包尾，先有完整对象才能 range 校验。
- **Worker（在线，10 ms 线内）**：只守结构闸——中央目录预扫（防穿越/重复条目/条数与解压总量上限）+ `pack.json` 局部解出对账。包体 sha256 由**编辑器本地算好**放进 `x-market-zip-sha256` 请求头，R2 put 用它做**原生校验**（与实际内容不符直接抛错，零 JS CPU）；Worker 自己对包体零哈希、零逐字节循环。
- **注册表侧（离线，无 CPU 线）**：数据级对账——逐文件 sha256 重算、明文树内容补全，merge 前后复核 + 人工审核。PR 正文带全量 sha256 声明表，R2 待审区保留 zip 原件可查。

一句话：**在线守住结构与形态，字节级真伪交给离线复核**。注意：注册表仓 CI 现行 validate 面向明文树，pack.json-only PR 需注册表侧跟进适配。

## 端点

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | 部署验证 `{ ok: true }` |
| `POST /device-token` | 签发 HMAC 设备 token（payload = uuid + 签发时间，TTL 30 天，重复领发新值） |
| `POST /publish` | `Authorization: Bearer <token>` + `x-market-zip-sha256: <64位十六进制>`（包体 sha256，编辑器本地算）+ body = zip 原始字节（必须带 `Content-Length`，≤99 MB）。校验 → R2 待审 → 开 PR → `{ ok, prUrl, pendingKey }` |
| `GET /index.json` | R2 索引镜像分发面（双源回退用；miss 回源 gh-pages 并缓存） |
| `POST /hook/pr-merged` | 注册表仓 webhook（`X-Hub-Signature-256` 验签）；`WEBHOOK_SECRET` 未配 ⇒ 503（cron 兜底仍在） |
| cron `17 */6 * * *` | gh-pages 权威索引 → R2 镜像对账（webhook 晚到/丢失时自愈） |

PR 开具用 Git Data API 一次提交整树（blobs→tree→commit→ref），注册表仓 master 是解包明文树，**仓里不放 zip**（zip 资产由 CI 打 GitHub Release——跟随现状）。免费档下 PR 先只带 `pack.json`（PR 正文带校验报告 + 逐文件 sha256 声明表），内容补全与数据级对账由注册表侧复核（见「免费档方案」）。同 head 分支已有 open PR ⇒ 幂等返回原 PR；base 上已存在同 `(id, version)` ⇒ 拒（bump version 再发）。

## 部署

```bash
pnpm install
pnpm wrangler deploy        # wrangler.toml 已定 binding：R2 桶 kojo-market、vars GITHUB_REPO
```

1. **R2 桶**：dashboard 建桶，名 `kojo-market`（与 wrangler.toml 一致）。
2. **Secrets**（三个，前两个必配）：

```bash
pnpm wrangler secret put GITHUB_TOKEN
# fine-grained PAT，仅授 Poboking/kojo-market：Contents: Read and write + Pull requests: Read and write
pnpm wrangler secret put DEVICE_TOKEN_SECRET   # ≥32 字节随机串（openssl rand -hex 32）
pnpm wrangler secret put WEBHOOK_SECRET        # 可选；不配则 /hook/pr-merged 返回 503
```

3. **Custom Domain**：dashboard 里给 Worker 绑 `market.3625735381.xyz`（代码/wrangler.toml 不硬编码域）。
4. **Webhook（可选，走实时归档）**：注册表仓 Settings → Webhooks：
   - URL `https://<你的域>/hook/pr-merged`，Content type `application/json`，secret 与 `WEBHOOK_SECRET` 一致；
   - 事件只勾 **Pull requests**。
5. **免费计划即可**：校验是结构级的（中央目录预扫 + `pack.json` 局部解出，对包体零逐字节循环），10 ms CPU 线内完成；上传硬限 99 MB 与分层取舍见「免费档方案」节。

## curl 验证

```bash
# 0. 健康
curl -s https://market.3625735381.xyz/health
# => {"ok":true}

# 1. 领设备 token
TOKEN=$(curl -s -X POST https://market.3625735381.xyz/device-token | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. 上传样例 zip（zip 根 = pack.json + files/**；可先用注册表 CI 的 market.mjs 从明文树打一个）
#    x-market-zip-sha256 = 包体 sha256（编辑器上传时同样本地计算随头声明）
ZIP_SHA=$(sha256sum demo.worker-1.0.0.zip | cut -d' ' -f1)
curl -s -X POST https://market.3625735381.xyz/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/zip" \
  -H "x-market-zip-sha256: $ZIP_SHA" \
  --data-binary @demo.worker-1.0.0.zip
# => {"ok":true,"prUrl":"https://github.com/Poboking/kojo-market/pull/<n>","pendingKey":"pending/demo.worker-1.0.0-<ts>"}

# 3. 查待审区（pending/ 的 zip 与同名 .json 元数据）
pnpm wrangler r2 object get "kojo-market/pending/demo.worker-1.0.0-<ts>.json"

# 4. 索引分发面（merge 后 webhook/cron 镜像进 R2；miss 时回源 gh-pages）
curl -s https://market.3625735381.xyz/index.json
```

拒绝样例：把包里混进 `../` 或把 `schema` 改成 2 再传，会得到
`{"rejected":{"code":"path-dotdot","message":"包里混入了 .. 上跳路径（路径穿越），已拒绝"}}` 这类结构化 JSON（HTTP 4xx/5xx，绝不静默 200）。

## 开发

```bash
pnpm test          # vitest：58 条（校验判据 golden / token / GitHub PR 构造 mock / webhook 验签与索引合并 / publish 处理器级上传链）
pnpm typecheck     # tsc --noEmit（strict + workers-types）
pnpm wrangler deploy --dry-run
```

R2 里 `packs/`、`pending/`、`index.json` 的语义：`pending/*` 是待审区（merge 后被归档并清空）；`packs/<id>-<version>.zip` 是已放行归档；`index.json` 是 gh-pages 权威索引的**镜像副本**（权威永远是 `https://poboking.github.io/kojo-market/index.json`）。
