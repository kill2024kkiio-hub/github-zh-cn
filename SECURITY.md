# 安全与隐私说明

## 这个扩展会不会收集我的数据

不会。项目没有服务器，也没有任何统计/上报代码：

- **界面汉化**（菜单、按钮、状态、相对时间、下拉选项、tooltip）完全在本地用词典完成，不产生任何网络请求。
- **正文翻译**与**机翻兜底**是可开关的功能，开启后只会把**该段纯文本**发给你在设置里选择的翻译服务：
  - 默认 `translate.googleapis.com`（Google 公开端点）
  - 或你自己填的 DeepL / Microsoft Translator / OpenAI 兼容接口（含本地 `127.0.0.1` 服务）
- 翻译结果缓存在浏览器本地 `chrome.storage.local`，可在设置页一键清空。
- 不读取、不上传 cookie、token、私有仓库元数据之外的任何页面结构信息；不注入远程脚本，无 `eval`，无远程配置。

如果你只想完全离线使用：关闭「正文翻译」和「机翻兜底」，界面汉化仍然完整工作。

## 权限清单与用途

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存开关、服务配置、自定义词条、翻译缓存 |
| `unlimitedStorage` | 翻译缓存较大时不受 5MB 限制 |
| `https://github.com/*`、`https://gist.github.com/*` | 只在 GitHub 页面上运行翻译脚本 |
| 各翻译服务域名 | 正文翻译 / 机翻兜底时调用 |
| `https://*/*` | 允许自定义 OpenAI 兼容接口（自建服务、局域网地址） |

`https://*/*` 范围较宽，是因为自定义接口地址由用户填写、扩展无法预知。若你使用默认的 Google 端点或固定服务商，可以在 `manifest.json` 里删掉这一项并把 `openaiBase` 换成固定域名。

## 仓库自身的防泄露措施

- `.gitignore` 排除 `node_modules/`、`.env*`、`*.pem`、`*.key`、日志、编辑器与系统文件
- `tools/scan-secrets.mjs` 在每次提交/CI 前扫描：本地绝对路径、GitHub PAT、模型服务 Key、AWS Key、私钥块、硬编码密码、邮箱、敏感文件名，以及「敏感文件是否已被 git 跟踪」
- CI（`.github/workflows/ci.yml`）在 Node 20/22 上跑全部测试 + 敏感信息自检 + manifest 完整性校验

提交前可随时本地自查：

```bash
npm run scan
```

## 报告问题

如果你发现安全问题（例如某处会把用户数据发送到预期之外的地址），请开 Issue 并描述复现步骤；涉及具体凭据的请勿在 Issue 里贴出真实密钥。
