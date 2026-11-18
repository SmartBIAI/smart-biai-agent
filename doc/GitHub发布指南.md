# 将 BIAI Agent 发布到 GitHub

建议先推到一个空的私有仓库，从干净目录克隆并验证启动，再将仓库设为公开。

可用仓库名 `smartbiai-openapi-agent`。仓库简介可以填「基于 Smart BIAI OpenAPI 的自托管工作台，支持海外社媒账号查询、视频生成和发布」。仓库主页可填写 [Smart BIAI 官网](https://www.biaibiai.com/)。

## 1. 确认可公开的文件

首批提交包括 `web/`、服务端 `.mjs` 文件、`package.json`、`package-lock.json`、`.gitignore`、README、部署说明、本指南，以及仅含示例配置的 `doc/.env.example`。

以下内容留在本地。`.gitignore` 已排除默认数据目录、SQLite 文件、密钥和内部文档；自定义备份、日志、截图等仍需核对实际暂存清单和提交历史。

- `doc/.env.local` 等真实环境配置，包含 Access Token、API Key 或其他连接信息。
- `.data/`、自定义数据目录的备份、SQLite 文件、解密密钥和任务日志。
- 内部 Claw 对接资料、内部实现参考、待审定的产品设计文档和设计稿。
- 真实账号资料、发布记录、带签名的媒体链接以及包含这些信息的截图。

公开前请由有权授权代码发布的一方确定软件许可证。将选定许可证的完整文本保存为根目录 `LICENSE`，并更新 README 的许可证一节。也请确认仓库名称、品牌素材和 Smart BIAI 接口信息的公开范围。参见 [GitHub 仓库许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

## 2. 创建本地提交

安装 Git，在包含 `README.md` 的项目目录打开 PowerShell 或终端。第一次初始化执行：

```sh
git init -b main
git check-ignore -v -- doc/.env.local .data/ "doc/SmartBIAI接口文档-内部Claw对接.md"
git add -- .gitignore .dockerignore Dockerfile README.md LICENSE package.json package-lock.json server.mjs integrations.mjs live-jobs.mjs mock.mjs media-storage.mjs web-access.mjs build-demo.mjs web deploy/compose.yml deploy/start.sh deploy/baota-nginx.conf.example deploy/.env.example doc/.env.example "doc/部署说明.md" "doc/宝塔Docker首次部署.md" "doc/GitHub发布指南.md"
git diff --cached --name-only
git diff --cached --stat
```

若已确定许可证，另执行 `git add -- LICENSE`。核对名单后提交：

```sh
git commit -m "Initial BIAI Agent release"
```

已有 Git 仓库时，从检查暂存清单开始，并查看既有提交历史。忽略规则只影响未跟踪的文件。如果密钥曾进入提交，先在供应商侧撤销和轮换，并按 [GitHub 移除敏感数据的说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) 检查历史。

## 3. 创建 GitHub 仓库并推送

打开 [GitHub 新建仓库](https://github.com/new)，选择你的账号或组织、填写仓库名，先选 **Private**。创建空仓库，保留本地现有的 README、许可证和 `.gitignore`。然后复制新仓库的 HTTPS 或 SSH 地址。

以下以 HTTPS 为例。把示例中的 `OWNER` 和仓库名替换为实际值：

```sh
git remote add origin https://github.com/OWNER/smartbiai-openapi-agent.git
git remote -v
git push -u origin main
```

按 Git 提示通过 GitHub 登录，也可提前用 `gh auth login` 登录 GitHub CLI 并配置 Git。参见 [将本地代码导入 GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)。

## 4. 验证并公开

1. 到 GitHub 检查文件列表、README 链接、许可证和提交历史，确认公开范围内没有真实凭证或业务数据。
2. 在另一个目录克隆仓库，用部署文档启动。验证空白环境可以运行模拟模式，配置模板可以正常复制，并检查文档链接。
3. 在仓库的 **Settings → General** 中更改可见性为 **Public**。公开后可添加 `smart-biai`、`openapi`、`social-media`、`video-generation`、`self-hosted` 等主题，方便开发者发现。参见 [GitHub 仓库可见性说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。
4. 可在 **Releases** 添加首个版本，例如 `v0.1.0`，介绍支持的接入流程并链接部署说明。
