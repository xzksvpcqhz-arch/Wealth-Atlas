# Wealth Atlas 开发流程

## 修改前

1. 每次修改代码前，必须先检查当前 Git 状态。
2. 不得覆盖或删除用户未要求修改的功能、真实财务数据或历史记录。
3. 涉及真实数据删除、数据库迁移或其他破坏性操作时，必须先要求人工确认。

## 修改与验证

1. 完成功能修改后，必须运行：
   - `npm test`
   - `npm run build`
2. DeepSeek/Hermes 审核为可选步骤，只有用户明确要求时才运行 `npm run prepare:review` 或读取 `review/result.json`。
3. 即使进行可选审核，也不得发送 `.env.local`、API Key、`data/`、`exports/`、`private-vault/`、`backups/` 或真实财务资料。

删除项目文件时，必须先移入 `D:\Trash`；如果无法移入，则停止并要求人工确认。
