# Wealth Atlas · Supabase 云端同步 · 建库步骤

> 按下面做，最后把 **项目 URL + anon key** 发给我（这两个是给前端用的"公开"值，不是秘密；**不要发 service_role key**）。

## 第 1 步：注册 Supabase 并建项目
1. 打开 https://supabase.com → 右上 **Sign in / Start your project**
2. 用邮箱注册登录（可 GitHub 登录）
3. 点 **New project**：
   - **Name**：`wealth-atlas`（随意）
   - **Database Password**：自己设一个强密码（记好，本地不会用，但以后要进数据库会用到）
   - **Region**：选离你近的（如 **Southeast Asia (Singapore)**）
4. 等 1~2 分钟项目初始化完成

## 第 2 步：运行建表脚本
1. 左侧菜单 **SQL Editor** → **New query**
2. 把本目录下的 `schema.sql` **整段复制粘贴**进去
3. 点 **Run**（或 Ctrl+Enter）
4. 看到成功提示即可

## 第 3 步：拿到两个值发给我
1. 左侧 **Settings → API**
2. 复制：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon / public** key（形如 `eyJhbGciOi...`，很长一串）
3. 把这两个值发给我（**只发 URL 和 anon key**，不要发 `service_role` 那个）

## 第 4 步：验证（可选，推荐跑一下）
在 SQL Editor 新建一个 query，粘下面这段，点 Run。能正常返回一行（显示 `user_data`）就说明表建好了：

```sql
select table_name, row_security from information_schema.tables
where table_schema = 'public' and table_name = 'user_data';
```

> `schema.sql` 是**幂等**的：如果不小心运行了两次也没关系，不会报错。

## 第 5 步：我会做
- 把这两个值接进 app 的环境变量（`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`，写进本地 `.env.local`，同时配到 Cloudflare Pages 构建变量）
- 写登录 + 同步界面（会先给你看预览再动手）
- 你的桌面 App + 手机 PWA 登录同一个账号后，数据就互通了

## 注意
- `anon key` 是**公开**的（前端要用它），可以安全写进 app；它配合 RLS 只允许用户访问自己的数据。
- `service_role` key 是**私密**的（有管理员权限），**绝不发给我、绝不写进 app**。
