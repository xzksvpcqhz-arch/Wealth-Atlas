# Wealth Atlas 开发与审核流程（强制）

## 修改前

1. 每次修改代码前，必须先检查当前 Git 状态。
2. 不得覆盖或删除用户未要求修改的功能、真实财务数据或历史记录。
3. 涉及真实数据删除、数据库迁移或其他破坏性操作时，必须先要求人工确认。

## 修改与验证

1. 完成功能修改后，必须运行：
   - `npm test`
   - `npm run build`
2. 测试通过后，必须运行：
   - `npm run prepare:review`
3. 完成 `prepare:review` 后必须停止修改，等待 Hermes/DeepSeek 审核。
4. Hermes/DeepSeek 的审核结果写入 `review/result.json`，使用以下命令读取：
   - `npm run read:review`

## 审核处理

1. 只有审核结果为 `PASS`，才允许报告任务完成。
2. 审核结果为 `FAIL` 时，只修复 P0 与 P1 问题。
3. 每次修复后必须依次重新运行：
   - `npm test`
   - `npm run build`
   - `npm run prepare:review`
4. 然后再次停止修改，等待 Hermes/DeepSeek 审核。
5. 最多自动循环 5 轮。
6. 若同一个问题连续两轮无法修复，必须停止并向用户说明原因。
7. 审核没有 `PASS` 前，不得提交最终 Git 版本。

## 审核数据保护

不得发送给 DeepSeek 或 Hermes：

- `.env.local`、API Key 或其他密钥
- `data/`、`exports/`、`private-vault/`、`backups/`
- 真实银行资料或真实财务资料

删除项目文件时，必须先移入 `D:\Trash`；如果无法移入，则停止并要求人工确认。
