import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readInstalledReleaseAcceptance, RELEASE_ASSET_NAMES, sha256 as assetSha256 } from "./release-acceptance.mjs";
const { load: parseYaml } = createRequire(import.meta.url)("js-yaml");

export function validateUpdateAssets(assets, version) {
  const installer = assets.find(({ name }) => name === "Wealth-Atlas-Setup.exe")?.bytes;
  const blockmap = assets.find(({ name }) => name === "Wealth-Atlas-Setup.exe.blockmap")?.bytes;
  const manifestBytes = assets.find(({ name }) => name === "latest.yml")?.bytes;
  if (!installer?.length || !blockmap?.length || !manifestBytes?.length) throw new Error("Publish blocked: a required update asset is missing or empty.");
  let manifest;
  try { manifest = parseYaml(manifestBytes.toString("utf8")); } catch { throw new Error("Publish blocked: update manifest is invalid YAML."); }
  const sha512 = createHash("sha512").update(installer).digest("base64");
  const file = manifest?.files?.[0];
  if (manifest?.version !== version || manifest.path !== "Wealth-Atlas-Setup.exe" || manifest.sha512 !== sha512
    || manifest.files?.length !== 1 || file?.url !== "Wealth-Atlas-Setup.exe" || file.sha512 !== sha512 || file.size !== installer.length) {
    throw new Error("Publish blocked: update manifest version, URL, size or SHA-512 does not match the installer.");
  }
}

export function assertReleaseSource({ version, committedVersion, head, tagCommit, dirty, remoteCommit, latestVersion }) {
  if (dirty || committedVersion !== version || !head || tagCommit !== head || remoteCommit !== head) {
    throw new Error("Publish blocked: commit the reviewed source and push its exact version tag before publishing.");
  }
  const validVersion = (value) => /^\d+\.\d+\.\d+$/.test(value);
  if (!validVersion(version) || (latestVersion && !validVersion(latestVersion))) throw new Error("Invalid release version.");
  if (latestVersion) {
    const next = version.split(".").map(Number);
    const current = latestVersion.split(".").map(Number);
    const firstDifference = next.findIndex((part, index) => part !== current[index]);
    if (firstDifference < 0 || next[firstDifference] < current[firstDifference]) throw new Error("Publish blocked: candidate must be newer than the public release.");
  }
}

export function assertCloudBuildConfigured(environment) {
  const address = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!address || !key) {
    throw new Error("Publish blocked: provide the existing cloud-login build configuration through local environment variables; no environment file has been read.");
  }
  let url;
  try { url = new URL(address); } catch { throw new Error("Build blocked: invalid cloud project URL; value suppressed."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /^(localhost|127\.|0\.|\[::1\])/.test(url.hostname)) throw new Error("Build blocked: use the existing production HTTPS cloud project URL; value suppressed.");
  let legacyAnonymous = false;
  try { legacyAnonymous = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8")).role === "anon"; } catch { /* Publishable keys are not JWTs. */ }
  if (!key.startsWith("sb_publishable_") && !legacyAnonymous) throw new Error("Build blocked: only a public publishable/anon key may enter the desktop bundle. Server/secret/service-role keys are forbidden; value suppressed.");
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}); credentials and response contents suppressed.`);
  return response.json();
}

export async function prepareGithubPublish(projectRoot, packageJson) {
  assertCloudBuildConfigured(process.env);
  const git = (...args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git("rev-parse", "HEAD");
  const version = packageJson.version;
  const tag = `v${version}`;
  let tagCommit;
  try { tagCommit = git("rev-parse", `${tag}^{commit}`); } catch { throw new Error("Publish blocked: the approved candidate has no local release tag."); }
  const committedVersion = JSON.parse(git("show", "HEAD:package.json")).version;
  const dirty = Boolean(git("status", "--porcelain", "--untracked-files=normal"));
  if (!process.env.GH_TOKEN) throw new Error("Publish blocked: set GH_TOKEN in the local environment; never send it through chat or commit it.");
  const { owner, repo, provider } = packageJson.build.publish;
  if (provider !== "github" || owner !== "xzksvpcqhz-arch" || repo.toLowerCase() !== "wealth-atlas") throw new Error("Unexpected publication destination.");
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "wealth-atlas-release" };
  let remote = await githubJson(`${api}/git/ref/tags/${tag}`, { headers });
  if (remote.object.type === "tag") remote = await githubJson(`${api}/git/tags/${remote.object.sha}`, { headers });
  const latest = await githubJson(`${api}/releases/latest`, { headers });
  assertReleaseSource({ version, committedVersion, head, tagCommit, dirty, remoteCommit: remote.object.sha, latestVersion: latest.tag_name.replace(/^v/, "") });
  return { api, headers, head, tag };
}

export async function publishCheckedRelease(context, releasePath, version) {
  if (existsSync(path.join(releasePath, "local-candidate-provenance.json"))) throw new Error("Publish blocked: local-candidate provenance cannot be promoted by changing environment flags.");
  const check = JSON.parse(readFileSync(path.join(releasePath, "release-check.json"), "utf8"));
  const installer = readFileSync(path.join(releasePath, "Wealth-Atlas-Setup.exe"));
  const sha256 = createHash("sha256").update(installer).digest("hex").toUpperCase();
  if (check.status !== "PASS" || !check.distributionReady || check.localCandidate === true || check.runtimeAcceptanceVerified !== true || check.sourceCommit !== context.head || check.version !== version || check.sha256?.toUpperCase() !== sha256 || !Array.isArray(check.checks) || !check.checks.length || check.checks.some((item) => !item.pass)) throw new Error("Publish blocked: release validation, approved source or installer hash does not match.");
  const names = RELEASE_ASSET_NAMES;
  // Read all assets before creating anything remotely. Only code/build artifacts are allowed.
  const assets = names.map((name) => ({ name, bytes: readFileSync(path.join(releasePath, name)) }));
  validateUpdateAssets(assets, version);
  readInstalledReleaseAcceptance(releasePath, { version, sourceCommit: context.head,
    assetHashes: Object.fromEntries(assets.map(({ name, bytes }) => [name, assetSha256(bytes)])) });
  const { api, headers, head, tag } = context;
  const existing = await fetch(`${api}/releases/tags/${tag}`, { headers });
  if (existing.status !== 404) throw new Error("Publish blocked: a release already exists or could not be checked; no existing release will be overwritten or deleted.");
  const release = await githubJson(`${api}/releases`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, target_commitish: head, name: `Wealth Atlas ${tag}`, draft: true, prerelease: false, body: buildReleaseBody(version, head, check.release) }),
  });
  const uploadUrl = release.upload_url.replace(/\{.*$/, "");
  if (new URL(uploadUrl).hostname !== "uploads.github.com") throw new Error("Unexpected asset upload host.");
  for (const { name, bytes } of assets) {
    const asset = await githubJson(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes,
    });
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (asset.state !== "uploaded" || asset.size !== bytes.length || asset.digest !== digest) throw new Error("Asset upload verification failed; release remains a draft.");
  }
  const verified = await githubJson(`${api}/releases/${release.id}`, { headers });
  if (!assets.every(({ name, bytes }) => verified.assets.some((asset) => asset.name === name && asset.state === "uploaded"
    && asset.size === bytes.length && asset.digest === `sha256:${createHash("sha256").update(bytes).digest("hex")}`))) throw new Error("Required update assets failed verification; release remains a draft.");
  await githubJson(`${api}/releases/${release.id}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ draft: false, make_latest: "true" }) });
  console.log(`Published ${tag}: source and all three update assets verified.`);
}

export function buildReleaseBody(version, head, signature) {
  if (version === "1.7.9") {
    return `Wealth Atlas v${version} — 更新中心\n\n设置页新增更新中心，显示真实程序版本、最近取得的正式版本、检查时间和下载进度。下载达到100%仍等待校验，只有安装包确认就绪后才提示保存操作并正常退出安装，不会强制关闭应用。\n\n完善失败重试间隔、重复点击、迟到事件、校验失败及初始化失败保护。更新状态和发布说明通过受限桌面接口读取，不接受任意下载地址或安装命令；开发、网页版和隔离测试模式不会假装执行安装。\n\n保留当前深色星空设计，以及账户、交易、预算、投资、Obsidian、删除恢复、账号同步和离线验证逻辑；不迁移或清空个人资料。\n\n发布前运行完整回归、更新器对抗测试、四个尺寸的界面及键盘验收，并对最终安装包执行独立虚构资料的payload启动、v1.7.8升级和回退兼容测试。隔离payload验收不等同实际NSIS安装向导或所有设备的端到端更新安装验收。\n\nSource commit: ${head}\nSignature: ${signature} (UNSIGNED builds have no verified Authenticode publisher and Windows may warn).\n\n正式Windows版联网后可后台检测并下载更新，保存操作并正常退出后安装，重新打开确认v${version}。无需卸载或清空资料；更新前建议自行导出Excel和Obsidian ZIP备份。`;
  }
  if (version === "1.7.8") {
    return `Wealth Atlas v1.7.8 — 我的投资\n\n新增 Windows 投资工作台：导入券商持仓快照与成交流水，核对重复记录和持仓变动，并按已导入资料拆解收益。证券资料与投资政策、事件日历及基准比较分开管理。\n\n真实券商未接入，不会执行交易或付款。投资版本只在用户确认保存后写入已连接的 Obsidian Vault；公开安装包不含个人持仓、成本、账户或 Vault 文件。\n\n发布前以模拟资料验证投资保存、并发、路径隔离及导入逻辑，并对最终安装包执行隔离启动及升级兼容验收。不等同于验证所有真实账户或实际安装向导。\n\nSource commit: ${head}\nSignature: ${signature} (unsigned builds may trigger a Windows warning).\n\n正式版联网后后台下载更新，正常退出后安装。已安装本地 v1.7.8 的设备不会因同版本号自动重装。`;
  }
  return `Wealth Atlas v${version}\n\nAdds an optional home DIY editor in Settings: manually enter sizes, adjust title/amount/description font weights independently, choose bounded motion presets, and hide or restore home modules and sidebar entries. Desktop, tablet and mobile layouts remain separate. The approved dark star theme stays the default.\n\nDisplay preferences sync through a separate account-owned configuration table, not the financial snapshot. Revision conflicts pause for explicit user choice; unsaved drafts are protected. Windows-to-Mac and Mac-to-Windows preference changes, including hide/restore and refresh persistence, were verified with the v1.7.7-rc.1 candidate. This does not certify every concurrent-edit or offline scenario on physical devices.\n\nRetains the existing next-launch automatic-login switch, email-only login history, account-isolated workspaces, guarded financial sync, password recovery and verified local-workspace offline reopening with online revalidation. No passwords or extra authentication-token copies are saved by the display editor. Existing financial calculations, historical FX snapshots and Obsidian workflows are unchanged. Offline access remains subject to the existing verification lifetime.\n\nFinal installer, blockmap and update manifest are bound to extracted-payload runtime acceptance before publication. This is not proof of every NSIS wizard, hardware or end-to-end update-install scenario.\n\nSource commit: ${head}\nSignature: ${signature} (UNSIGNED builds have no verified Authenticode publisher and Windows may warn).\n\nNo automatic adoption of candidate data. Existing unassigned local records stay local; account synchronization uses the corresponding account workspace. Back up important records before updating. No user files or Obsidian handwritten content are deleted by this release preparation.`;
}
