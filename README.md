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

## 新功能

- **素材照片**：在「基础资料」的 Logo 下面上传讲师、人物、产品、地点、仪器的照片（每个 Campaign 最多 24 张），每张可以写说明（例如「陈老师」）。AI 写内容时会自己帮每张内容配合适的照片；你也可以在每张内容右边点选（最多 6 张）。出 Mockup、Variants、Upscale 时，这些照片会跟 Logo 一起送给图片模型，照实放进画面（人物保留长相、产品保留外观）。
- **Upscale 后自动写文案**：AI 看完成的图，自己判断最适合哪一个结构，写 Primary Text＋Headline＋Description。结构有 SLAP、AIDA、PAS、BAB、FAB、4P、Hook-Story-Offer。每张正式图下面可以复制，或选另一个结构按「重写」。文字模型要能看图（例如 GPT 系列）；看不到图的模型会改用图上文字和主视觉来判断。

## 要知道的

- **执行时间**：每次生成在一个请求里跑完，设定的上限是 300 秒。Vercel 免费方案如果比较短，一次出很多张可能会超时 → 一次少出几张，或升级方案。
- **API 要 OpenAI 兼容**：文字用 `/responses`，图片用 `/images/generations`、`/images/edits`。
- **图片网址**是公开但随机的长网址（Vercel Blob），没有网址的人看不到。
- **Mock 模式**（设定里打开）：不叫 API、不花钱，出假图测试流程。
- **改内容规则**：改 `docs/CONTENT-SKILL.md`，push 上 GitHub 就会自动重新部署。

## 在电脑上跑（不用 Vercel）

1. 电脑要有 Node.js。
2. 双击 **start.bat**，浏览器会打开 http://localhost:3000。
3. 第一次会自动建立 `local.env`：填 `AI_API_KEY`（和 `AI_API_BASE`，用别家 API 才要），保存后重开 start.bat。
4. 资料存在 `.local` 资料夹。如果这个资料夹里有旧版 app 的 `data` 和 `output`，第一次开会自动导入旧的 Logo、Campaign 和图片，也会沿用旧版设定里的 API key。
