# Wealth Atlas GitHub 自动更新与发布

发布仓库：`xzksvpcqhz-arch/Wealth-Atlas`（公开）。GitHub 只分发代码和安装包，不保存个人财务资料。跨设备财务同步属于独立功能，本流程不会触发它。

## 使用者如何更新

- 正式 Windows 应用启动时后台检查稳定版本，联网且存在更高版本时下载。
- 下载完成不会强制关闭页面；正常退出后由现有 NSIS 更新器安装，随后重新打开查看新版本。
- 焦点回到应用时可重试：正常检查间隔 30 分钟，失败后的重试间隔至少 1 分钟。
- 不自动降级，不接收预发布版本。离线或检查失败不阻断启动。
- 使用者无需 GitHub Token；公开更新源不会携带发布凭据。
- 开发运行和隔离测试 profile 不连接线上更新器。
- 已有 v1.7.3 使用旧更新器；必须安装本候选后，新行为才生效。

## 发布前确认

1. 检查 Git 状态、当前分支、HEAD 和最新公开 release；版本必须更高。
2. 保留所有未提交改动，不清空用户资料，不读取私密资料目录。
3. 用户确认后才能保存最终 commit/tag。提交全部已确认的相关代码，不能只提交版本号。
4. 本地 tag、远程 tag、已提交的 package 版本和构建源码必须一致。不得移动旧 tag、覆盖旧 release 或强推。
5. 构建只使用本机环境变量。`GH_TOKEN` 只用于发布；前端云配置只允许公开 publishable/anon key，禁止 secret/service-role key。
6. `NEXT_PUBLIC_APP_URL` 未知时不设置，不填空格。空白值可在构建进程中忽略，不修改系统保存值。

## 验证与候选打包

在本修复分支所在目录执行；以下命令不会发布：

```text
npm test
npm run build
npm run release:test-updater
npm run release:windows
npm run release:test-installed
```

环境变量应通过本机安全方式载入进程，不把真实 Token 写进命令文本、源码、日志或聊天。构建不会读取或自动删除任何遗留 token 文件；发现该文件即停止。没有正式证书时，候选包明确标注 UNSIGNED。

桌面升级测试使用提取后的真实安装包程序和隔离虚拟 profile，不运行实际安装向导，不替换用户安装，不改变注册表或个人资料。

## 经用户确认后发布

先提交并推送已确认的源码及精确版本 tag，再使用本机发布环境运行：

```text
npm run release:publish
```

脚本会再次检查源码、版本和配置，再构建、校验，最后创建 GitHub draft。必须上传且逐项验证以下三个文件的大小及服务器 SHA-256，才会公开为 latest：

- `Wealth-Atlas-Setup.exe`
- `Wealth-Atlas-Setup.exe.blockmap`
- `latest.yml`

清单内版本、文件名、文件大小和 SHA-512 必须与安装包一致。任何步骤失败时停止；已创建的 draft 保留，不自动删除或覆盖其他 release。`release-check.json` 的 PASS 仅说明本地检查通过；`distributionReady` 必须为 true，并且远程公开文件完成核对，才能称为正式发布成功。

## 发布后

- 核对公开 release 的 tag 与源码 commit，以及全部更新资产。
- 在独立测试环境验证真实公开更新下载，再安排实际安装验收。不能用模拟网络测试代替正式端到端验收。
- 吊销临时 GitHub Token，并手动移除本机临时发布凭据。
- 未签名不会因为上传 GitHub 而变成已签名，SmartScreen 仍可能提醒。
- 不删除旧 release。需要修正已公开版本时，发布更高版本，不能让自动更新回退个人资料。
