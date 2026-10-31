# v1.7.7-rc.1 排版同步候选包交接

历史构建交接；后续真实双设备验收见 [v1.7.7 发布前验收](RELEASE_V1_7_7_ACCEPTANCE.md)。

## 状态

- 正式源码基准仍为 v1.7.6 / 6867777dfc09fb5d969fcc270985e8adb0d4881c。
- 当前 DIY 与候选构建修改未提交，未创建 tag，未发布 GitHub，未替换正式安装。
- 候选版本：v1.7.7-rc.1，仅在隔离构建副本与候选包中设置版本。
- 最终候选目录：`desktop-dist/display-candidates/v1.7.7-rc.1-2026-10-31T16-13-45-443Z-343d01d5/`。
  时间戳为 UTC；本地交接为 2026-11-01。不要使用较早的同版本内部试构建。

## 本轮修改

- `scripts/build-display-candidate.mjs`：独立的 Windows/Mac 候选构建，限定代码输入、
  公共资源 Git 白名单、公开云构建变量、临时源码、独立 profile、输出独占和校验和。
- `scripts/test-display-candidate.mjs`：提取后的实际 EXE 运行验证，仅新 UUID 虚构 profile，
  使用进程内拒绝代理阻止联网，不读真实 profile，不安装或切换用户窗口。
- `tests/display-candidate.test.mjs`：19 项安全/隔离/构建契约检查；package.json 追加测试入口。
- `docs/DISPLAY_CANDIDATE_TEST.md`：随包说明；`docs/MAC_DISPLAY_CANDIDATE_PROMPT.md`：Mac 端交接。
- 本记录。没有更改首页/财务/认证/Obsidian 代码或 UI，保留上一轮 DIY 接入。

独立审核发现 Git 只读元数据命令也继承了原进程发布凭据，现已让所有子进程显式使用
清理后的环境；加入回归后重新构建最终候选。旧内部试构建保留，不删除或覆盖。

## 验证结果

- `npm test`：322/322；类型检查通过。无环境文件的隔离源码副本执行。
- `npm run build`：通过。
- 候选 Windows 与 Mac static export：均通过，使用现有依赖，未升级依赖。
- Windows 最终 EXE：13 个隔离阶段通过，包括空白启动、资源、布局、保存重开、编辑、
  软删除、恢复及账号隔离；绑定 EXE 和 app.asar 的 SHA-256。
- Mac 包内网页：Windows Chromium 上 40/40 通过，0 renderer error；不等于 macOS 实测。
- 签名：NotSigned / UNSIGNED，Publisher 无。没有正式证书，不声称受 Windows 信任。
- PE FileVersion 为 1.7.7-rc.1，数值 ProductVersion 为 1.7.7.0；Electron/app/package 版本为候选版本。
- 云端只读元数据复核：独立显示表存在，RLS 启用并强制，本人 SELECT/INSERT/UPDATE
  限定 user_id；匿名 SELECT、authenticated DELETE/TRUNCATE 不允许。本轮没有改表或读财务行。
- Git 差异格式检查通过。

Windows 运行证据：候选目录内 `local-runtime-check.json`。
网页证据：`work/display-integration-qa/05b08f95-d1ab-41bc-bf02-59723001149b/`。
测试/构建目录不提交为真实资料，也不充当真实双设备验收证据。

## 最终文件与 SHA-256

```text
8f52f28dea9f7e86c86c443c9a09f0a1452c594add3881e2f2966adbdd266c70  Wealth-Atlas-Display-Test-v1.7.7-rc.1-Windows-UNSIGNED.zip
d88c93e117b011e99b42020e490fe02e8559f4b32c54487eaaec421b5b9578c9  Wealth-Atlas-Display-Test-v1.7.7-rc.1-Mac-Web.zip
bc55987d1f1c9b4526fef539e3265660be255e002df0437e004703e2e144a8cd  windows/win-unpacked/resources/app.asar
d41aa3e472eee7d32967c60a217e091ca1d0e205fc2bbb26309577eed81273bc  windows/win-unpacked/Wealth Atlas Display Candidate.exe
```

Windows 应解压完整 ZIP，不单独搬动 EXE。使用新的
`%APPDATA%\Wealth Atlas Sync Candidate\1.7.7-rc.1`；不读取、复制或清理正式 profile。
Mac 应保留原浏览器和 `http://127.0.0.1:43175` 来源，更新程序而不清理浏览器资料。

## 待验收

1. 用户确认后才打开手动 Windows 候选窗口，用户亲自登录已有独立测试账号。
2. 把指定 Mac ZIP 传到 Mac Documents，交接 prompt 核对 hash、切换服务器、保持来源。
3. Windows 保存显示参数，Mac 实际接收和刷新保留；再明确安排 Mac 反向保存。
4. 两端确认显示方案专属状态，不能用财务“已连接”替代。
5. 真实账号/物理 Mac/真实双设备同步、冲突选择、正式安装升级、GitHub 发布均未通过验收。

`candidate-check.json` 仍保留 BUILT_FOR_MANUAL_TEST、distributionReady=false 和各待测标记；
通过的本机运行证据独立记录，不把原构建清单改写为正式可分发版本。
