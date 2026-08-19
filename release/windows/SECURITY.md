# Wealth Atlas 安全验证说明

版本：v{{VERSION}}  
发布状态：**{{SIGNATURE_STATUS}}**  
预期发布者：**{{PUBLISHER}}**

## 核对 SHA-256

在安装包所在文件夹打开 PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath ".\Wealth-Atlas-Setup.exe"
```

预期 SHA-256：

```text
{{SHA256}}
```

## 查看 Authenticode 签名

```powershell
Get-AuthenticodeSignature -LiteralPath ".\Wealth-Atlas-Setup.exe" | Format-List Status,StatusMessage,SignerCertificate
```

只有 `Status` 为 `Valid`，并且发布者与上方预期发布者一致时，才是经过正式 Authenticode 验证的安装包。`UNSIGNED` 版本没有可验证发布者，Windows SmartScreen 仍可能显示“未知发布者”。

请同时使用 Windows Defender 扫描。哈希、数字签名和杀毒扫描各自只提供一种验证信号，不能构成“保证安全”。
