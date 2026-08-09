# Wealth Atlas

个人财富星图的本地优先 Web App。

## Run

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## Obsidian 同步

v0.4.0 通过设置页连接本地 Obsidian Vault。连接动作只会创建缺失的 `财富理财师/` Folder 和模板；读取与写入只发生在用户明确点击“开始扫描并生成预览”或“确认同步”之后。

同步会先显示新增、更新、无变化和冲突文件。确认后才写入，并在 Vault 内生成 `backups/obsidian/YYYY-MM-DD-HHmm/` 备份。没有文件夹权限时，可以使用每日、每月、每年或完整文件夹 ZIP 下载。

自动生成区域使用 `WEALTH_ATLAS_AUTO_START` 和 `WEALTH_ATLAS_AUTO_END` 标记；标记以外的手写内容不会被覆盖。同步日志、Vault 名称、模板和金融数据保存在本地 IndexedDB，私人 Markdown 内容不会进入 Git。

## v0.5.0 FX center

The FX center keeps SGD/MYR, USD/SGD, MYR/SGD, and SGD/USD history locally. Every manual entry appends a new version instead of overwriting the old rate. Transactions and transfers save the original amount, conversion direction, rate date, source, fees, and effective rate snapshot so future rates cannot rewrite historical results.

It also provides currency exposure, the next-30-day MYR gap, the USD → SGD → MYR investment path, stale/missing-rate alerts, and scenario-only simulations. Wealth Atlas does not call a live FX API or execute exchanges automatically.

## Data privacy

应用数据保存在浏览器 IndexedDB。真实财务数据不应该提交到 Git；导出文件和私人 Vault 已加入 `.gitignore`。
