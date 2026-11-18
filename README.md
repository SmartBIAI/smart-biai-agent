# Smart BIAI Agent

基于 Smart BIAI OpenAPI 的自托管 AI 工作台，在对话中查询海外社媒账号、生成图片与视频、编辑文案，并确认立即发布或预约发布视频作品。

[在线体验](https://developer.biaibiai.com/smart-biai-agent-static/) · [Smart BIAI 官网](https://www.biaibiai.com/) · [视频 API 文档](https://developer.biaibiai.com/docs)

在线体验使用模拟数据，记录保存在当前浏览器。部署自己的工作台后，可以填写个人或团队的 API 凭证，使用真实服务。

模拟视频预览使用项目自带的约 4 秒示例素材，由部署站点直接提供。

## 功能

| 页面 | 支持的操作 |
| --- | --- |
| BIAI Agent | 查询账号、生成图片与视频、查看报价、图片大图预览、播放视频、编辑发布草稿、查看历史对话 |
| 社媒账号 | 筛选 TikTok、YouTube、Instagram 账号，查看授权状态和通过本应用发布的作品 |
| 发布任务 | 查看视频生成模型与时长、图片生成记录、发布进度和预约时间，取消尚未提交的预约 |
| 连接设置 | 配置 Smart BIAI、DeepSeek 或豆包，以及本地文件服务或阿里云 OSS |

图片生成、视频生成与发布均由用户确认后执行。账号需处于已授权状态，实际发布能力以账号权限和平台要求为准。账号和作品运营数据、全量历史作品同步列入后续计划。

真实模式从 OpenAPI 动态读取当前应用获授权的视频和图片模型，参数以实时能力为准。公开体验预置 8 个已开放视频模型与 12 个图片模型，用固定示例素材演示流程。

## 快速开始

安装 Node.js 22.13 或更新版本，在终端运行以下命令。

```sh
git clone https://github.com/SmartBIAI/smart-biai-agent.git
cd smart-biai-agent
npm ci
npm start
```

打开 [http://127.0.0.1:4173/](http://127.0.0.1:4173/)，选择「模拟模式」即可体验，无需 API 密钥。在 Windows PowerShell 中，也可使用 `npm.cmd ci` 和 `npm.cmd start`。

服务器安装请参阅 [Docker 部署指南](doc/宝塔Docker首次部署.md)，已有实例见 [部署更新指南](doc/更新说明.md)。本地配置、参考素材和静态体验版构建方法见 [使用与配置](doc/部署说明.md)。

## 连接真实服务

在「连接设置」中填写下表的信息，也可复制 [环境配置模板](doc/.env.example) 为 `doc/.env.local` 后填写。

| 服务 | 所需信息 |
| --- | --- |
| Smart BIAI 社媒 | App ID、Access Token，以及账号查询和发布权限 |
| Smart BIAI 图片与视频生成 | 应用 API Key，以及相应视频模型或图片模型的授权 |
| DeepSeek 或豆包 | 对应供应商的 API Key 和已开通的模型 ID，选择其中一家 |

Smart BIAI 凭证的获取和申请入口见 [Smart BIAI 官网](https://www.biaibiai.com/)。真实生成和 AI 调用会消耗相应服务的额度。

配置后切换到「真实模式」，可以输入「查询 TikTok 账号」、「生成两张马克杯产品海报」或「使用 Seedance2.5 生成一条 20 秒的竖屏产品短片」。先查看报价并确认生成。图片可在对话中查看大图并打开原图；视频预览完成后，再选择账号、检查文案和时间，确认发布。

## 数据与运行方式

- 生成图片与视频通过服务返回的地址直接预览，本地保存链接、有效期和任务信息。视频封面取自生成结果，缺失时留空。
- 用户上传的参考附件保存在工作台服务器。选择本地公网文件服务或 OSS 后，应用会为生成服务准备限时读取链接。
- 对话、草稿和任务保存到 SQLite。模拟和真实模式的记录分别保存，已确认的预约在切换模式后仍会继续执行。
- 预约发布依赖应用持续运行，实际公开时间取决于 Smart BIAI 和社媒平台处理进度。
- 每个实例使用一个共享工作空间。Docker 部署提供共享管理员访问账号，持有账号的人可以访问该实例的全部数据和连接设置。

## 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/SmartBIAI/smart-biai-agent/issues) 提交问题或功能建议，也欢迎提交 Pull Request。报告问题时请附上复现步骤和经过脱敏的错误信息。

## 许可证

项目源码采用 [Apache License 2.0](LICENSE)，SPDX 标识为 `Apache-2.0`。外部 API 服务的接入和使用遵循对应服务的条款。
