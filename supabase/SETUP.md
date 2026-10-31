# Wealth Atlas · Supabase 配置与权限核查

本地代码和线上数据库是两件事。修改本目录不会自动执行线上 SQL，
也不能据此声称线上 RLS 已通过。当前加固候选尚未应用到生产项目。

## 已有项目：先做只读检查

1. 打开 Supabase Dashboard，选择正确项目 → **SQL Editor → New query**。
2. 执行 `audit-user-data.sql`。它只读取系统目录，**不读取财务记录**，不修改权限。
3. 检查 RLS、anon/authenticated 实际权限、策略、索引、触发器和 Realtime 配置。
   可提供这些技术元数据供复核；不要发送 Table Editor 中的资料、密码或密钥。
4. 先在单独测试项目使用虚构 A/B 用户验证允许/拒绝行为，再考虑正式库变更。

完整验收和已知限制见 `../docs/CLOUD_PERMISSIONS.md`。

## 权限候选：不要未经确认在正式库执行

`schema.sql` 是新建表/已有表权限加固的**人工审批候选**。它没有财务行的
UPDATE、INSERT、DELETE 或清空操作；权限变更在一个有超时的事务里提交。
它会收紧现有 API 权限，所以不能当作普通说明随意在生产运行。

正式执行前必须：

- 用户明确确认；建议先导出 Excel 和 Obsidian ZIP 备份。
- 保存当前权限、策略和触发器定义，制定恢复权限配置的方案；不要回退个人资料。
- 升级并验证所有写入端。旧版 upsert 可能依赖此候选刻意禁止的身份列更新权限，
  而且不具备新的冲突保护。不要让新旧版本同时写同一个账号。
- 暂停同步写入，先在测试项目验证；通过后再决定生产应用次序。
- 运行只读审核并验证 A/B 用户隔离、并发修改和 Realtime 行为。

脚本不删除未知策略；额外的限制性归属策略防止宽松策略意外放开其他用户的行。
它禁止客户端删除**整份云端快照**，不禁止正常 JSON 内的交易删除、恢复和回收站。
数据库管理员、service_role、BYPASSRLS 以及其他特权 RPC 仍需单独审核。

## 新项目

创建项目时选择合适区域并妥善保存数据库密码。保留邮箱确认，不要为了省步骤关闭
身份验证。审核 `schema.sql` 后，只在新的空白测试项目先执行和验收。

客户端只使用 **Project URL + publishable key**，或现有兼容的 **anon key**。
通过本机环境变量或受控构建环境配置，不必发到聊天：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

绝不能把 secret/service_role key、数据库密码、用户密码、JWT 或访问令牌放入客户端、
Git 或聊天。公开 key 本身不是用户身份，也不替代 RLS。

## 无财务内容的线上初步探测

在已经配置上述**公开**构建变量的终端运行：

```text
node scripts/check-cloud-permissions.mjs
```

只发送 HEAD + limit=0，不登录用户、不下载响应内容。401/403 仅说明该匿名请求被拒绝；
200 是「需要元数据审核」，不是安全 PASS。此命令不加载 `.env.local`，不更改线上资料。
