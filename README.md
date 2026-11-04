# Winning Ads OS · Content（网上版 / Vercel）

填基础资料 → 选行业 → 定 Creative direction → AI 写内容＋诊断 → Mockup → Variants → Upscale → 下载。团队共用一个密码登入。

## 第一次部署（大概 10 分钟）

1. **Vercel → Add New → Project → Import** 这个 GitHub repo（`winning-ads-os`）。Framework 选 **Other**，其他不用改，先按 Deploy。
2. **加两个储存**（Vercel 项目 → Storage）：
   - **Blob** → Create → 连到这个项目（会自动加 `BLOB_READ_WRITE_TOKEN`）。放图片和 Logo。
   - **Upstash for Redis**（Marketplace，有免费方案）→ 连到这个项目（会自动加 `KV_REST_API_URL`、`KV_REST_API_TOKEN`）。放内容、设定和任务进度。
3. **加环境变量**（Settings → Environment Variables）：

   | 名字 | 填什么 |
   | --- | --- |
   | `APP_PASSWORD` | 团队登入密码（必填，不然谁都能用） |
   | `AI_API_KEY` | 你的 API key |
   | `AI_API_BASE` | API 网址，OpenAI 兼容。默认 `https://api.openai.com/v1` |
   | `AI_TEXT_MODEL` | （可空）文字模型名，默认 `gpt-6-astra` |
   | `AI_IMAGE_MODEL` | （可空）图片模型名，默认 `gpt-image-2.5-flare` |

4. **Deployments → 最新那个 → Redeploy**（环境变量要重新部署才生效）。
5. 打开网址，输入密码，就可以用了。模型名、API 网址之后也可以在网页「设定」里改。

## 要知道的

- **执行时间**：每次生成在一个请求里跑完，设定的上限是 300 秒。Vercel 免费方案如果比较短，一次出很多张可能会超时 → 一次少出几张，或升级方案。
- **API 要 OpenAI 兼容**：文字用 `/responses`，图片用 `/images/generations`、`/images/edits`。
- **图片网址**是公开但随机的长网址（Vercel Blob），没有网址的人看不到。
- **Mock 模式**（设定里打开）：不叫 API、不花钱，出假图测试流程。
- **改内容规则**：改 `docs/CONTENT-SKILL.md`，push 上 GitHub 就会自动重新部署。

## 本地预览（可选）

```
node dev.js        # → http://localhost:3000，资料存在 ./.local
APP_PASSWORD=xxx AI_API_KEY=xxx node dev.js
```
