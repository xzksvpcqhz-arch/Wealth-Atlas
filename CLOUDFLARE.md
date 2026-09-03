# Wealth Atlas · Cloudflare Pages 部署（手机 PWA）

手机版就是**同一个 App 打包成静态网页**，部署到 Cloudflare Pages，用浏览器打开后「添加到主屏幕」即可像 App 一样用，且能用 Supabase 云同步。

## 前置条件

- 已建好 Supabase 项目，拿到 **Project URL** 和 **anon/public key**（见 `supabase/SETUP.md`）。
- 仓库已推到 GitHub：`xzksvpcqhz-arch/Wealth-Atlas`。

## 部署步骤

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git**。
2. 选仓库 `xzksvpcqhz-arch/Wealth-Atlas`。
3. 构建设置：
   - **Framework preset**：`None`（或 `Other`）
   - **Build command**：`npm run build:web`
   - **Build output directory**：`out`
   - Node 版本：≥ 20（默认即可）
4. 环境变量（**Production 和 Preview 都要加**；这两个是构建时内联进页面的，必须在这里设置）：
   | 名称 | 值 |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | 你的 `https://xxxx.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 你的 anon/public key |
5. **Save and Deploy**。完成后会得到一个 `https://xxx.pages.dev` 地址。

## 手机上安装成 App（PWA）

1. 手机浏览器打开那个 `.pages.dev` 地址。
2. iOS：分享 → 加到主屏幕；Android：菜单 → 安装应用 / 加到主屏幕。
3. 打开后登录同一个 Supabase 账号，数据就会和桌面端一致。

## 注意事项

- **邮箱确认邮件**：如果 Supabase Auth 开了「邮箱确认」，注册后会收到确认邮件；确认链接会跳转到 Supabase 默认域名。可在 Supabase → Auth → URL Configuration 把 **Site URL** 设成你的 `.pages.dev` 地址，并在 **Redirect URLs** 里加上它。
- **HTTPS**：Cloudflare Pages 自带 HTTPS，PWA / Service Worker 才能正常工作。
- **更新缓存**：每次发新版，`public/sw.js` 里的 `CACHE_NAME` 要递增（当前 `v1.2.0`），否则手机可能显示旧页面。
- **密钥安全**：只放 `NEXT_PUBLIC_SUPABASE_ANON_KEY`（public 的），**绝不**放 `service_role` key。RLS 已保证每个用户只能读写自己的数据。
