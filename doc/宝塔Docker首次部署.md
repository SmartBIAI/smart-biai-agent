# 宝塔服务器首次部署 BIAI Agent 完整应用

部署后可以使用自己的 Smart BIAI 和对话 AI 密钥，查询真实账号、上传参考素材、生成视频和确认发布。默认正式入口是 `https://developer.biaibiai.com/smart-biai-agent-app/`，现有公开体验页位于 `/smart-biai-agent/`。本指南按宝塔 Nginx 在宿主机、Open API 已通过 Docker 运行的环境编写。

## 1. 准备与上传

服务器需要 Linux x86_64、Docker Engine 和 Docker Compose V2。宿主机无需安装 Node.js。宝塔终端或 SSH 执行：

```bash
uname -m
docker version
docker compose version
```

`uname -m` 应显示 `x86_64`。如果 Compose 使用独立命令，执行 `docker-compose version`，版本需为 2.x。启动脚本同时支持这两种调用方式。ARM 服务器需要另行构建对应架构镜像。

通过宝塔「文件」把以下两个文件上传到 `/opt/biai_packages/`：

- `smart-biai-agent-docker-0.1.0-linux-amd64.tar.gz`
- `smart-biai-agent-docker-0.1.0-linux-amd64.tar.gz.sha256`

压缩包包含 Linux 镜像 `images.tar`、Compose 配置、环境模板、启动脚本、Nginx 配置示例和本指南。密钥由部署者在服务器上填写。

直接从 GitHub 源码构建的方式也可用：在源码目录执行 `docker build --platform linux/amd64 -t smart-biai-agent:0.1.0-docker.1 .`，将 `deploy/` 中的配置文件复制到独立的运行目录后，按本指南继续。离线包已包含镜像，可直接导入。

## 2. 解压并填写设置

首次安装目录为 `/opt/smart-biai-agent-app/`，其中的 `data/` 将保存数据库、历史对话、上传附件和加密配置。先确认该目录未用于另一套部署，再执行：

```bash
mkdir -p /opt/biai_packages
cd /opt/biai_packages
sha256sum -c smart-biai-agent-docker-0.1.0-linux-amd64.tar.gz.sha256
tar -xzf smart-biai-agent-docker-0.1.0-linux-amd64.tar.gz -C /opt
cd /opt/smart-biai-agent-app
sha256sum -c SHA256SUMS
cp .env.example .env
chmod 600 .env
```

在宝塔文件编辑器中打开 `/opt/smart-biai-agent-app/.env`。至少修改下面的访问设置：

```dotenv
BIAI_PUBLIC_ORIGIN=https://developer.biaibiai.com
BIAI_BASE_PATH=/smart-biai-agent-app
BIAI_BIND_PORT=4178
BIAI_LOGIN_USER=admin
BIAI_LOGIN_PASSWORD=CHANGE_ME_BEFORE_START
```

把密码占位符换成至少 16 位的独立密码。可以在终端运行 `openssl rand -hex 24` 生成后复制进去。用户名只用英文字母、数字、下划线、短横线或点。API 密钥可稍后在登录后的「连接设置」填写。

如果在 `.env` 填写服务密钥，使用模板已有的变量名。选择 DeepSeek 时填写 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL`；选择豆包时把 `BIAI_AI_PROVIDER` 改成 `doubao`，再填写 `ARK_API_KEY`、`DOUBAO_MODEL`。社媒服务填写 `BIAI_SOCIAL_APP_ID`、`BIAI_SOCIAL_ACCESS_TOKEN`，视频服务填写 `BIAI_VIDEO_API_KEY`。这些变量也可留空，先通过模拟模式验收安装。

这是一套共享管理员工作台。知道访问账号和密码的人可以查看此实例的全部账号、对话和任务，并修改连接设置。

## 3. 导入镜像并启动

```bash
cd /opt/smart-biai-agent-app
sh start.sh
```

脚本会导入离线镜像、检查访问账号和路径配置、创建持久化目录并启动容器。镜像里的进程以 UID 1000 的普通用户运行，首次创建的数据目录会设置成相应权限。

启动后检查：

```bash
curl -fsS http://127.0.0.1:4178/healthz
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail 50 agent
```

独立版 Compose 用户将上面和下文中的 `docker compose` 换成 `docker-compose`。健康接口应返回 `{"status":"ok"}`。容器的健康状态通常会在半分钟内变成 `healthy`。

宿主端口默认绑定到 `127.0.0.1:4178`，由宝塔 Nginx 对外提供 HTTPS。如果 4178 被占用，修改 `.env` 中的 `BIAI_BIND_PORT` 和下一步的 Nginx 目标端口后，再执行 `sh start.sh`。

## 4. 配置宝塔 Nginx

打开「网站 → developer.biaibiai.com → 配置文件」。备份当前内容，把下面两段加到域名的 HTTPS `server { ... }` 中，与现有 `location` 同级：

```nginx
location = /smart-biai-agent-app {
    return 308 /smart-biai-agent-app/;
}

location ^~ /smart-biai-agent-app/ {
    proxy_pass http://127.0.0.1:4178;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    client_max_body_size 101m;
    proxy_connect_timeout 10s;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    access_log off;
}
```

`proxy_pass` 后面的端口没有末尾斜杠，转发时会保留 `/smart-biai-agent-app/` 前缀，应用据此识别请求。`Host` 与 `BIAI_PUBLIC_ORIGIN` 的域名一致。`Authorization` 用于工作台的访问登录。

在宝塔保存前检查配置：

```bash
/www/server/nginx/sbin/nginx -t
```

通过后在宝塔重载 Nginx。访问 `https://developer.biaibiai.com/smart-biai-agent-app/`，浏览器会弹出账号密码窗口，输入 `.env` 中的工作台访问账号和密码。该登录通过 HTTPS 传输。

如希望完整应用使用原 `/smart-biai-agent/` 地址，将 `BIAI_BASE_PATH` 及以上两段路径统一改成 `/smart-biai-agent`，并将原静态体验的同名 `location` 替换为这两段，再执行 `sh start.sh`。同一个路径只能配置一个入口。

## 5. 首次验收与真实连接

1. 登录后先选「模拟模式」，查账号、生成示例视频、确认一次模拟发布。刷新后应能恢复历史对话。
2. 在「连接设置」配置 Smart BIAI 社媒、视频及 DeepSeek 或豆包。切到「真实模式」，确认账号和视频模型可以加载。
3. 对话上传参考图片时，可以选择 OSS。输入 Bucket、地域和密钥，或在 `.env` 填写 `OSS_*` 变量。访问浏览器的文件先上传到工作台，点击「准备素材并报价」后才将所选素材上传到 OSS。
4. 选择本地文件服务器时，公网域名填 `https://developer.biaibiai.com`，附件目录留空。应用会自动生成带 `/smart-biai-agent-app/media/` 前缀的限时链接。该路径验证签名后供 Smart BIAI 取件，工作台其他路径要求登录。外部取件需要服务器的 HTTPS 可达。
5. 确认报价后才会消耗额度生成视频。预览完成后选择测试账号并单独确认发布。只有状态为 `20` 已授权的可用账号可以发布。定时任务依赖容器保持运行。
6. 检查原来的 `/docs`、Open API 接口和 `/smart-biai-agent/` 公开体验页仍可按当前配置使用。

## 6. 数据、备份和重启

`.env` 改动后执行 `sh start.sh`，Compose 会按新环境重新创建容器。数据库和附件位于部署目录的 `data/`，保留该目录和 `.env`，重建容器后仍可读取。连接页保存的密钥保存在数据库中，并使用数据目录里的密钥文件加密。

停机备份示例：

```bash
cd /opt/smart-biai-agent-app
install -d -m 0700 /opt/biai_backups
docker compose -f compose.yml stop agent
archive="/opt/biai_backups/biai-agent-$(date +%Y%m%d-%H%M%S).tar.gz"
umask 077
if tar -czf "$archive" data .env compose.yml; then
    chmod 600 "$archive"
    docker compose -f compose.yml up -d
else
    docker compose -f compose.yml up -d
    exit 1
fi
```

恢复时先停止实例，再用同一份备份还原数据目录和环境配置。共享管理员登录状态由浏览器管理，改密码后会要求重新输入。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动提示修改密码 | 编辑 `.env` 中的访问账号和密码，保存后重新执行 `sh start.sh`。 |
| 宝塔访问 502 | 查容器状态、`/healthz`、Nginx 转发端口及日志。 |
| 访问 403 或保存设置提示来源无效 | 核对 `BIAI_PUBLIC_ORIGIN` 与浏览器实际 HTTPS 域名一致，Nginx 保留 `Host`。 |
| 页面打开但资源 404 | 检查路径前缀、URL 末尾斜杠和 `proxy_pass` 配置。 |
| 数据目录权限不足 | 首次目录应由脚本创建。自备目录需让容器 UID 1000 有读写权限。 |
| 模型或账号加载失败 | 检查各类密钥、应用授权和出站网络。 |
| 登录失效或重复弹窗 | 检查输入的工作台密码，以及是否有其他网关覆盖 `Authorization`。 |

部署包按 Linux amd64 构建。服务器端和本机的真实服务配置相互独立，需要在新实例重新填写连接信息。
