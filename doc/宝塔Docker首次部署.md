# Docker 部署指南

本指南从公开仓库构建镜像，使用 Docker Compose 运行一个持久化的共享工作台，并通过 Nginx 提供 HTTPS 访问。宝塔用户可在站点配置页面应用同样的代理规则。

## 环境要求

- Linux 服务器，安装 Docker Engine、Docker Compose V2 和 Git。
- 一个可用的域名和 HTTPS 证书。
- 服务器能够访问 npm 软件源、Smart BIAI 和所选 AI 服务。
- 当前用户有 Docker 使用权限，以及部署目录的读写权限。

以下域名使用 `agent.example.com`，应用路径使用 `/smart-biai-agent/`，请将域名替换为自己的域名。路径与仓库自带的 Compose 和 Nginx 示例一致。

## 构建并准备配置

```sh
git clone https://github.com/SmartBIAI/smart-biai-agent.git
cd smart-biai-agent
docker build -t smart-biai-agent:0.2.0-docker.1 .
cd deploy
cp .env.example .env
chmod 600 .env
```

编辑 `deploy/.env` 中的访问设置。

```dotenv
BIAI_PUBLIC_ORIGIN=https://agent.example.com
BIAI_BASE_PATH=/smart-biai-agent
BIAI_BIND_PORT=4178
BIAI_LOGIN_USER=admin
BIAI_LOGIN_PASSWORD=CHANGE_ME_BEFORE_START
```

将密码占位符替换为至少 16 位的独立密码，可用 `openssl rand -hex 24` 生成。用户名支持英文字母、数字、下划线、短横线和点。这个账号可访问该实例全部对话、任务和连接设置。

API 信息可以在此文件填写，也可启动并登录后在「连接设置」填写。变量列表见 [使用与配置](部署说明.md#配置-api-服务)。

## 启动

在 `deploy/` 目录执行以下命令。

```sh
sh start.sh
curl -fsS http://127.0.0.1:4178/healthz
docker compose -f compose.yml ps
```

启动脚本会检查配置、创建 `deploy/data/` 并启动容器。应用以 UID 1000 的用户运行，首次创建的数据目录会配置相应权限。健康检查应返回 `{"status":"ok"}`。

若使用独立的 `docker-compose` 命令，下文将 `docker compose` 替换为 `docker-compose`。启动脚本支持这两种调用方式。

容器端口映射到宿主机的 `127.0.0.1:4178`，由 Nginx 对外提供 HTTPS。端口被占用时，修改 `BIAI_BIND_PORT` 并同步修改代理目标端口。

## 配置 HTTPS 代理

将域名解析到服务器，在 Nginx 中为该域名配置 HTTPS。宝塔用户进入「网站 → 自己的域名 → 配置文件」，在 HTTPS `server { ... }` 中加入以下两段，与其他 `location` 同级。

```nginx
location = /smart-biai-agent {
    return 301 /smart-biai-agent/$is_args$args;
}

location ^~ /smart-biai-agent/ {
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

配置文件示例也见 [`deploy/baota-nginx.conf.example`](../deploy/baota-nginx.conf.example)。`proxy_pass` 保留原请求路径，`Host` 与 `BIAI_PUBLIC_ORIGIN` 的域名一致。

执行 `nginx -t`，通过后重载 Nginx。宝塔默认安装可使用 `/www/server/nginx/sbin/nginx -t`，再在面板重载。若 Nginx 运行在容器中，需要让它能够访问应用容器，并按实际容器网络设置 `proxy_pass`。

打开 `https://agent.example.com/smart-biai-agent/`，在浏览器弹出的登录窗口中输入工作台账号和密码。若自定义路径，请同时修改 `BIAI_BASE_PATH` 与两段 Nginx 路径。跳转采用 301，以兼容旧版 Nginx；版本差异见 [Nginx return 指令说明](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return)。

### 自定义访问路径

例如，希望正式应用位于 `/agent/`，首次启动前将 `.env` 中的 `BIAI_BASE_PATH` 改为 `/agent`，并让 Nginx 的两个 `location` 使用同一路径。`proxy_pass` 保留完整请求路径，端口后省略末尾斜杠。

`BIAI_PUBLIC_ORIGIN` 和 `BIAI_MEDIA_PUBLIC_ORIGIN` 只填写 HTTPS 域名。URL 前缀与部署目录、数据目录分别配置。

已经启动的实例更改 `.env` 后，需要在部署目录执行 `sh start.sh`，让容器读取新配置。

## 连接与验收

1. 先用模拟模式查账号、生成示例视频并确认模拟发布，检查刷新后是否能恢复记录。
2. 在「连接设置」填写 Smart BIAI 社媒 App ID、Access Token、视频 API Key，以及 DeepSeek 或豆包配置。
3. 切到真实模式，确认授权账号和可用视频模型能够加载。查看生成报价后再确认真实生成。
4. 参考素材选择 OSS 或本地文件服务器。选择本地方式时，填写自己的公网 HTTPS 域名，容器附件目录留空。应用会为素材生成带路径前缀的限时链接。
5. 视频生成后先预览，选定有发布权限的测试账号，检查文案和时间，再确认发布。

## 数据和运行管理

`deploy/data/` 保存数据库、对话、附件和加密密钥，`deploy/.env` 保存启动配置。容器重建时沿用这两个位置即可继续读取记录。自定义附件目录应位于持久化挂载内，例如 `/data/uploads`。

修改 `.env` 后在 `deploy/` 目录重新执行 `sh start.sh`。查看状态和日志可使用以下命令。

```sh
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail 50 agent
docker compose -f compose.yml restart agent
```

定时发布需要容器持续运行。停机后的补交规则见 [数据、排期和备份](部署说明.md#数据排期和备份)。

## 备份和更新

在 `deploy/` 目录执行以下命令，将数据和环境配置备份到父目录，备份完成后恢复服务。

```sh
docker compose -f compose.yml stop agent
umask 077
backup_file="../biai-agent-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
if tar -czf "$backup_file" data .env compose.yml; then
    docker compose -f compose.yml up -d
else
    docker compose -f compose.yml up -d
    exit 1
fi
```

备份成功后更新源码、重建镜像并启动。

```sh
cd ..
git pull --ff-only
docker build -t smart-biai-agent:0.2.0-docker.1 .
cd deploy
docker compose -f compose.yml up -d --force-recreate
curl -fsS http://127.0.0.1:4178/healthz
```

恢复备份前先停止实例，再还原匹配的数据和环境配置。备份包含服务密钥和业务记录，应限制访问权限。

已使用离线镜像包安装的实例，请参阅 [部署更新指南](更新说明.md)。沿用原目录和 `.env`，无需重新配置已保存的连接信息。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动提示修改密码 | 替换 `.env` 中的密码占位符后重新启动。 |
| Nginx 返回 502 | 检查容器状态、健康接口和代理目标端口。 |
| 请求返回 403 | 检查公网域名、`BIAI_PUBLIC_ORIGIN` 和转发的 `Host` 是否一致。 |
| 页面资源返回 404 | 检查 URL 路径前缀、末尾斜杠和 Nginx 代理规则。 |
| 数据目录无写入权限 | 确认容器 UID 1000 可以读写数据目录。 |
| 登录窗口反复弹出 | 核对访问密码及代理是否正确传递 `Authorization`。 |
