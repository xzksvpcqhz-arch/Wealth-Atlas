# Hermes ↔ Codex 文件审核流程

这套流程只在项目本地交换审核文件，不修改 Wealth Atlas 的 UI、功能、数据结构或财务计算，也不修改 Hermes 的全局配置。

## 1. Codex 准备审核请求

在项目根目录运行：

```bash
npm run prepare:review
```

脚本会读取当前已跟踪文件的 Git diff，并把可以安全交给 Hermes 的未跟踪代码文件一并写入 `review/request.json`。它不会读取 `.env.local`、`data/`、`exports/`、`private-vault/` 或 `backups/`，也会排除构建产物、导出文件、图片和压缩包。发现常见 API Key 或 Bearer Token 形式时会进行脱敏。

`review/request.json` 是审核输入快照。它包含变更文件、代码差异、可审核的未跟踪代码、建议重跑的测试和排除路径，不包含真实财务资料。

## 2. Hermes 执行审核

Hermes 只读取 `review/request.json` 中提供的材料，检查代码质量、回归风险、测试结果和用户要求的合规性。Hermes 不应读取或上传被排除的目录，不应修改项目文件，也不应启动自动修复循环。

审核完成后，Hermes 将严格按照以下结构写入项目根目录的 `review/result.json`：

```json
{
  "status": "PASS",
  "summary": "审核总结",
  "issues": [
    {
      "id": "DS-001",
      "severity": "P0",
      "file": "文件路径",
      "line": 0,
      "problem": "问题说明",
      "suggested_fix": "建议修复方式"
    }
  ],
  "tests_to_repeat": [],
  "verified_requirements": []
}
```

只有在没有 P0/P1 问题且现有测试通过时，才可以使用 `PASS`。尚未审核时，仓库中的模板会保持 `FAIL` 状态，表示等待 Hermes 结果，不代表一次真实审核已经完成。

## 3. Codex 读取审核结果

Hermes 写入结果后，在项目根目录运行：

```bash
npm run read:review
```

脚本会验证结果 JSON，显示 PASS/FAIL、summary、全部 P0/P1/P2 问题、需要重跑的测试以及已验证要求。也可以传入另一个结果文件路径：

```bash
npm run read:review -- review/rounds/round-001-result.json
```

读取脚本只报告结果，不会自动修改代码。有效的 `PASS` 返回退出码 0；有效的 `FAIL`、格式错误或文件缺失返回退出码 1，方便在本地流程中识别需要人工处理的审核结果。

## 4. 审核轮次

`review/rounds/` 保留给未来人工保存审核轮次快照。当前桥接不会自动复制、覆盖或清理其中的文件，也不会建立自动修复循环。

提交前请再次确认 `review/request.json` 和 `review/result.json` 不含真实财务金额、私人文件内容或 API Key。
