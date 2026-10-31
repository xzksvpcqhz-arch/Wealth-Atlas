# 首页 DIY 与账号显示方案

入口：设置 → 首页自定义排版。首页的“调整排版”也打开同一编辑器。
现有首页默认不变；只有保存启用的设备方案后，才使用 DIY 布局。

## 保存范围

- 桌面、平板、手机分别保存模块次序、宽高、间距、字号、字重、有限动效和隐藏状态。
- `amount` 是金额文字的 **字号（px）**，不是财务金额。
- 侧边栏只保存静态入口 ID。隐藏不删除资料或功能；首页和设置不可隐藏。
- 配置不允许包含账户、交易、金额、汇率、备注、Vault 内容、凭证、任意 CSS 或脚本。
- 财务按钮在编辑模式中不可执行；正常首页仍使用原有处理函数。
- 保存、取消、撤销、重做只操作显示方案，不操作财务 snapshot。

## 工作区与云端

本机配置使用独立 `wealth-atlas.display-preferences.v1.*` 键：
未绑定资料、访客及每个已验证账号互相隔离，不自动把本机方案绑定给账号。
登录账号使用现有已验证身份与 Supabase client，不新建认证会话。

云端只使用 `public.user_ui_preferences`，与财务表独立：

- 主键为本人 `user_id`；RLS 强制限制本人 SELECT、INSERT、UPDATE。
- 客户端只能新增本人显示参数、更新 `preferences`，不能改归属、版本或时间。
- 不授予 DELETE 或 TRUNCATE。恢复默认通过保存一份默认显示参数完成。
- 服务端验证严格字段白名单、模块 ID、数值范围及版本；不接受额外私密字段。
- 修订号由服务端递增，更新携带预期修订号，避免静默覆盖另一设备方案。
- 两端均修改时暂停，需明确选择云端方案或已保存的本机方案。
- 未保存草稿、不可读本机配置或其他窗口的更新都不能成为云端覆盖依据。
- 离线保留本机方案；联网、返回页面或轮询时重试。每次请求有 15 秒截止时间。
- 账号切换时中止旧请求，旧账号回调不能写入新工作区。

`supabase/display-preferences.sql` 是本次已应用的独立表定义记录，包含对象碰撞检查。
不要对已有对象重复执行或借此改动现有财务表。

## 验证

```text
npm test
npm run build
npm run desktop:build
npm run desktop:test
```

普通 `npm run build` 不刷新 `out/`。检查静态导出或桌面版前，必须先运行对应的
`desktop:build` 或 `build:web`，并核对引用的静态产物。

显示功能专项：

```text
node --test tests/display-preferences-hook.test.mjs
node scripts/display-preferences-preview.mjs <隔离源码副本的 out 绝对目录>
node_modules/.bin/electron.cmd scripts/display-preferences-e2e.cjs <上一步输出的本机地址>
```

专项测试只使用新建隔离 profile 和虚构资料。模拟云传输、临时表权限检查和单机
响应式测试不等同于 Mac/Windows 真实账号互验或正式安装包升级验收。
不要用测试通过替代真实设备尚未完成的项目，也不要为测试清空个人资料。
