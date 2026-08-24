# Wealth Atlas 发布流程（每次发布照做）

> 仓库已公开：`xzksvpcqhz-arch/Wealth-Atlas`。**自动更新不需要 token**（公开仓库走公开 feed + 下载 URL）；token 只在"上传发布"时需要。

## 发布前必须知道的 3 件事

1. **版本号必须比已发布的高**（如当前最新 1.6.3 → 下一个 1.6.4），否则已安装应用不会触发更新。
2. **token 永远不会被嵌进安装包**（只有显式设 `WEALTH_ATLAS_EMBED_TOKEN=1` 才嵌入，仅私有仓库场景需要）。
3. **已知坑**：electron-builder 偶尔不上传 `.blockmap`，发布后必须核对，缺了就手动补传（命令见步骤 8）。

---

## Step-by-step

### 1. 检查工作区
```powershell
cd "E:\DeepSeek Project\Deepseek info\WealthAtlas"
git status          # 工作区要干净
```

### 2. 升版本号
- 打开 `package.json`：`"version": "1.6.3"` → `"1.6.4"`（比当前已发布版本高）
- 同步改 `package-lock.json` 顶部两处 `"version"`（第 3 行和第 9 行附近；**别碰** `node_modules/use-sync-external-store` 那种依赖自己的版本）

### 3. 验证（AGENTS.md 硬性要求）
```powershell
npm test
npm run build
```

### 4. 提交
```powershell
git add package.json package-lock.json
git commit -m "chore: bump version to 1.6.4"
```

### 5. 创建一次性发布 token（每次发布都新建，用完即删）
1. GitHub → 右上头像 → **Settings** → **Developer settings** → **Fine-grained personal access tokens** → **Generate new token**
2. Token name：`wealth-atlas-publish`
3. Expiration：7 天即可
4. Repository access：**Only select repositories** → `Wealth-Atlas`
5. Repository permissions → **Contents: Read and write**（只需要这一个权限）
6. Generate，复制 `github_pat_...`

> ⚠️ token 只留在你本地终端/密码管理器，**绝不发到聊天、绝不嵌进安装包**。

### 6. 在项目目录注入 token 并发布
```powershell
cd "E:\DeepSeek Project\Deepseek info\WealthAtlas"
$env:GH_TOKEN="你的新token"
npm run release:publish
```
- 发布需要几分钟（Next 构建 + electron-builder 打包 + 上传）。
- 成功标志：`Windows release check: PASS`，退出码 0。

### 7. 核对 release
- 打开 `https://github.com/xzksvpcqhz-arch/Wealth-Atlas/releases`
- 确认最新 release：**非草稿**、tag 是 `vX.Y.Z`、**3 个资产**：
  - `latest.yml`
  - `Wealth-Atlas-Setup.exe`
  - `Wealth-Atlas-Setup.exe.blockmap`

### 8. 缺 `.blockmap` 就手动补传（常见坑）
```powershell
# 先拿到 release_id：
# GET https://api.github.com/repos/xzksvpcqhz-arch/wealth-atlas/releases/tags/vX.Y.Z  → 响应里的 "id"
$releaseId="这里填release的id"
$env:GH_TOKEN="你的token"
curl.exe -s -X POST -H "Authorization: Bearer $env:GH_TOKEN" -H "Accept: application/vnd.github+json" -H "Content-Type: application/octet-stream" --data-binary "@desktop-dist\vX.Y.Z\Wealth-Atlas-Setup.exe.blockmap" "https://uploads.github.com/repos/xzksvpcqhz-arch/wealth-atlas/releases/$releaseId/assets?name=Wealth-Atlas-Setup.exe.blockmap"
```
> 注意 endpoint 是 **`uploads.github.com`**，不是 `api.github.com`。响应里出现 `"state":"uploaded"` 即成功。

### 9. 吊销这次用的 token
GitHub → Settings → Developer settings → Fine-grained PAT → 删除 `wealth-atlas-publish`。

### 10. 完成
- 已安装应用下次启动会自动更新（不需要你做任何事）。
- 想立即生效：让用户重启一次 app，首页右上角应显示新版本号。

---

## 出问题时

| 现象 | 处理 |
|---|---|
| `403 Resource not accessible by personal access token` | token 缺写权限 → 去 GitHub 把 Contents 改成 **Read and write** |
| 上传成功但 `latest.yml` 版本不对 | 检查 package.json 版本是否比已发布的高 |
| 旧版 app 不更新 | 等下次启动（只在启动时检查）；或手动装最新安装包一次 |
| 想回退 | 别删旧 release；等用户重启后它只会升到更高版本，不会降级 |
