# Smart BIAI 海外社媒运营开放接口文档

文档更新：2026-11-19 · 接口前缀：`/v1`

[Smart BIAI 官网](https://www.biaibiai.com/) · [图片与视频生成 API](https://developer.biaibiai.com/docs) · [Smart BIAI Agent 开源项目](https://github.com/SmartBIAI/smart-biai-agent) · [BIAI Agent 在线体验](https://developer.biaibiai.com/smart-biai-agent-static/)

本文公开地址：[Smart BIAI 海外社媒运营开放接口文档](https://developer.biaibiai.com/docs/SmartBIAI海外社媒运营开放接口文档.md)。

目录：[概述](#1-概述) · [认证与通用约定](#2-请求与响应约定) · [账号查询](#3-查询社媒账号) · [素材登记](#4-登记视频素材) · [视频标签](#5-视频标签) · [创建发布](#6-创建视频发布任务) · [发布状态](#7-查询发布任务状态) · [错误与重试](#8-错误处理与重试) · [接入流程](#9-推荐接入流程) · [常见问题](#10-常见问题)

## 1. 概述

Smart BIAI 社媒运营 API 面向自有应用、内容工作台和自动化流程，提供海外社媒账号查询、视频素材登记、视频标签管理、视频发布及发布状态查询能力。

本文覆盖以下 6 个接口。账号需先在 Smart BIAI 完成接入和授权；App ID、Access Token 及接口权限请前往 [Smart BIAI 官网](https://www.biaibiai.com/) 获取或申请。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/account/page` | 分页查询已接入的社媒账号 |
| POST | `/v1/material/video/batch-create` | 批量登记视频素材，取得视频 ID |
| POST | `/v1/material/video-label/create` | 创建视频标签 |
| GET | `/v1/material/video-label/page` | 分页查询视频标签 |
| POST | `/v1/publish/videos` | 批量创建视频发布任务 |
| GET | `/v1/publish/status` | 查询一条发布任务的状态 |

当前说明涉及 **TikTok、YouTube、Instagram**。可发布账号、服务有效期与发布能力，以账号授权、应用权限及平台要求为准。

本文不包含账号绑定或重新授权、账号及作品运营统计、平台全量历史作品查询、图片发布和主动取消已提交发布任务的接口。图片与视频生成属于另一组 API，见上方生成 API 文档。

### 1.1 两种视频发布方式

| 方式 | 操作顺序 | 适用场景 |
| --- | --- | --- |
| 视频直链 | 查询账号 → 使用 `videoUrl` 创建发布任务 → 查询任务状态 | 已取得可访问的视频地址，例如 AI 视频生成结果 |
| 素材 ID | 查询账号 → 登记视频素材取得 `videoId` → 使用 `videoId` 创建发布任务 → 查询任务状态 | 需要保存素材记录、附加标签或复用素材 ID |

**素材登记只保存记录，不会上传、转存视频文件。** `url` 仍指向调用方提供的视频地址；取得视频 ID 不代表视频已经被永久存储。发布时源地址必须仍可访问。

Smart BIAI Agent 当前采用视频直链方式发布，并保存发布响应返回的关联视频 ID。开发者也可以使用本文的素材及标签接口组织自己的素材库。

## 2. 请求与响应约定

### 2.1 服务地址

```text
https://border-api.biaibiai.com/open-api
```

完整请求地址由服务地址加接口路径组成，例如：

```text
https://border-api.biaibiai.com/open-api/v1/account/page
```

该地址与图片、视频生成服务地址不同。**社媒 App ID + Access Token 与生成服务的应用 API Key 是两组凭证，不能混用。**

### 2.2 请求头

| Header | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <access_token>`，注意 `Bearer` 后有一个空格 |
| `Client-Id` | 是 | 与 Access Token 配套的 App ID |
| `Content-Type` | 是 | `application/json`；GET 请求仍通过 URL 查询参数传值，不发送 JSON 请求体 |
| `Idempotency-Key` | 创建发布任务时必填 | 一次批量发布请求的唯一键，最长 64 个字符；重试必须使用原键和原请求体 |

本文仅对 `POST /v1/publish/videos` 约定必填幂等请求头。不要将发布接口的幂等保证推定为其他写接口的保证。

凭证应由应用后端保存并调用，避免将完整 Access Token 写入网页源码、公开仓库或公开日志。

### 2.3 参数与分页

- GET 参数放在查询字符串中；POST 参数为 JSON。素材登记和视频发布的请求体均为**数组**，即使只有一条记录也需要使用数组。
- 分页从 `pageNo=1` 开始，默认每页 `10` 条，`pageSize` 最大为 `50`。
- 分页响应通过 `data.list` 返回本页记录，`data.total` 返回总数。完整获取列表时逐页读取，不要只使用第一页。
- `createTime` 等响应时间戳以毫秒为单位。`expiryDate` 为日期字符串，例如 `2027-12-31`。
- 账号 ID、视频 ID、标签 ID 等数值标识可能为 64 位整数。JavaScript 调用方应使用无精度损失的 JSON 解析和序列化方式；不要先转为 `Number` 再保存。请求中声明为整数的字段仍需按整数发送。
- 发布任务 `id`、`clientTaskId`、`Idempotency-Key` 为字符串。它们与素材 `videoId`、AI 视频生成任务 ID 不是同一种标识，不能互换。

### 2.4 统一响应

成功时业务码 `code` 为 `0`，`data` 的结构由各接口定义：

```json
{
  "code": 0,
  "msg": "",
  "data": {}
}
```

业务失败示例：

```json
{
  "code": 401,
  "msg": "未认证或令牌已失效",
  "data": null
}
```

部分响应可能另外包含 `reason`、`traceId`、`requestId` 等字段，也可能为 `null`。诊断问题时可保留服务返回的追踪标识，不应将这些可选字段作为成功判断条件。

**同时检查 HTTP 状态与业务码。HTTP 200 不代表 `code=0`；创建发布任务返回 `code=0` 只表示本次创建请求成功，不表示作品已经发布完成。** 发布结果还需查询 `data.status`。

### 2.5 示例环境

下文 cURL 示例适用于 Bash 等兼容 Shell。先设置自己的配置：

```sh
export BIAI_SOCIAL_BASE_URL="https://border-api.biaibiai.com/open-api"
export BIAI_SOCIAL_APP_ID="YOUR_APP_ID"
export BIAI_SOCIAL_ACCESS_TOKEN="YOUR_ACCESS_TOKEN"
```

示例账号、标签、视频、任务 ID 和 `media.example.com` 地址均为占位数据。请替换成自己的已授权账号、真实接口返回的 ID 和有效视频地址；示例响应不代表实际调用结果。

示例幂等键同样只用于演示。新的发布批次应生成自己的唯一键，同一批次重试时保留原键。

## 3. 查询社媒账号

### `GET /v1/account/page`

查询当前凭证可访问的账号。发布前先取得目标账号 ID，并确认授权及服务状态。

#### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageNo` | integer | 否 | 页码，从 1 开始，默认 1 |
| `pageSize` | integer | 否 | 每页条数，默认 10，最大 50 |
| `id` | integer(int64) | 否 | 按账号 ID 查询 |
| `platform` | integer | 否 | 平台编码，见下表 |

| 平台编码 | 平台 |
| --- | --- |
| `10` | TikTok |
| `40` | YouTube |
| `70` | Instagram |

国家、名称和别名可以使用返回字段在调用方筛选。本接口当前参数表未定义 `country`、`name`、`keyword` 等服务端筛选参数，不应自行假定传入即可生效。

#### 请求示例

```sh
curl --get "$BIAI_SOCIAL_BASE_URL/v1/account/page" \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  --data-urlencode 'pageNo=1' \
  --data-urlencode 'pageSize=20' \
  --data-urlencode 'platform=10'
```

按指定账号查询时，增加 `id` 参数即可。

#### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.list` | array | 本页账号列表 |
| `data.total` | integer | 记录总数 |
| `list[].id` | integer(int64) | 社媒账号 ID，用于发布请求的 `accountId` |
| `list[].platform` | integer | 平台编码 |
| `list[].country` | string | 国家信息，例如 `US`；按实际返回值处理 |
| `list[].name` | string | 账号名称 |
| `list[].alias` | string | 账号别名，可能为空 |
| `list[].profileImage` | string | 头像地址 |
| `list[].authStatus` | integer | 账号授权状态 |
| `list[].expiryDate` | string | 服务到期日期 |
| `list[].createTime` | integer(int64) | 创建时间，毫秒时间戳 |

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "list": [
      {
        "id": 101,
        "platform": 10,
        "country": "US",
        "name": "brand-example",
        "alias": "品牌主号",
        "profileImage": "https://media.example.com/avatar.jpg",
        "authStatus": 20,
        "expiryDate": "2027-12-31",
        "createTime": 1795046400000
      }
    ],
    "total": 1
  }
}
```

#### 授权状态与发布条件

| `authStatus` | 含义 | 是否允许创建发布任务 |
| --- | --- | --- |
| `10` | 未授权 | 否 |
| `20` | 已授权 | 是，仍需满足账号有效期、应用权限和平台要求 |
| `30` | 授权失败 | 否 |
| `40` | 授权异常 | 否 |

调用方必须在确认发布前检查账号状态；定时发布到期时也应重新检查。未知状态按不可发布处理。账号需要授权或恢复授权时，在 Smart BIAI 完成相应操作。

## 4. 登记视频素材

### `POST /v1/material/video/batch-create`

批量登记已有视频的地址和信息，返回可用于发布的素材 ID。该接口名称中的“上传”指提交素材记录，**不接收文件二进制，不使用 multipart，不会把视频文件上传或转存到 Smart BIAI**。

如果仅需要使用现成视频地址发布，可以跳过本接口，直接在发布请求中使用 `videoUrl`。

#### 请求体

请求体为对象数组，下表字段作用于数组中的每一项。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 视频名称，最多 255 个字符 |
| `url` | string | 是 | 视频文件地址，最多 1000 个字符 |
| `coverUrl` | string | 否 | 封面地址，最多 1000 个字符；无封面时可传空字符串 |
| `label` | string | 否 | 视频标签 ID 列表，多个 ID 用英文逗号分隔，最多 255 个字符，例如 `"501,502"` |
| `copywriting` | string | 否 | 素材文案，最多 1000 个字符；不替代后续发布必填的 `title` |
| `fileSize` | integer(int64) | 否 | 已知的视频文件大小，单位字节；未知时省略 |
| `videoDuration` | integer(int64) | 否 | 视频时长，单位秒；未知时省略 |
| `suffix` | string | 否 | 文件后缀，最多 50 个字符，例如 `mp4` |

建议使用无需登录即可读取的公网 HTTPS 视频直链，确保发布处理期间地址不失效。不要使用网页播放页地址代替视频文件地址。无封面时不必另外生成封面，示例使用 `coverUrl: ""`。

#### 请求示例

```sh
curl "$BIAI_SOCIAL_BASE_URL/v1/material/video/batch-create" \
  -X POST \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  --data '[
    {
      "name": "产品演示视频",
      "url": "https://media.example.com/product-video.mp4",
      "coverUrl": "",
      "videoDuration": 6,
      "suffix": "mp4"
    }
  ]'
```

如需关联标签，先创建或查询标签，再增加 `"label": "501,502"`。不要将标签名称写入 `label` 代替标签 ID。

#### 成功响应

```json
{
  "code": 0,
  "msg": "",
  "data": [
    {
      "id": 42802,
      "name": "产品演示视频",
      "url": "https://media.example.com/product-video.mp4"
    }
  ]
}
```

`data[].id` 为视频素材 ID，可用于发布请求中的 `videoId`。保存返回的 ID 与视频地址关联，不要使用 AI 视频生成任务 ID 代替它。视频已存在等错误需结合 `code`、`msg` 和已保存记录处理；本接口未约定与发布接口相同的幂等重试能力。

## 5. 视频标签

### 5.1 创建标签

**`POST /v1/material/video-label/create`**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 标签名称，最多 255 个字符 |

```sh
curl "$BIAI_SOCIAL_BASE_URL/v1/material/video-label/create" \
  -X POST \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  --data '{"label":"产品演示"}'
```

成功时 `data` 直接返回标签 ID，不是包含 `id` 的对象：

```json
{
  "code": 0,
  "msg": "",
  "data": 501
}
```

标签已存在时可能返回如下业务失败。可通过标签分页接口查找已有标签后复用，不必反复创建。

```json
{
  "code": 1005003000,
  "msg": "视频标签已存在",
  "data": null
}
```

### 5.2 分页查询标签

**`GET /v1/material/video-label/page`**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageNo` | integer | 否 | 页码，从 1 开始，默认 1 |
| `pageSize` | integer | 否 | 默认 10，最大 50 |
| `label` | string | 否 | 按标签名称模糊查询 |
| `createTime[0]` | string | 否 | 创建时间范围起点，格式 `YYYY-MM-DD HH:mm:ss` |
| `createTime[1]` | string | 否 | 创建时间范围终点，格式同上 |

时间范围应同时传入起点和终点；过滤时间按服务约定的时区填写，不要将返回的毫秒时间戳直接作为上述日期字符串参数发送。

```sh
curl --get "$BIAI_SOCIAL_BASE_URL/v1/material/video-label/page" \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  --data-urlencode 'pageNo=1' \
  --data-urlencode 'pageSize=20' \
  --data-urlencode 'label=产品' \
  --data-urlencode 'createTime[0]=2026-11-01 00:00:00' \
  --data-urlencode 'createTime[1]=2026-11-19 23:59:59'
```

#### 成功响应

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "list": [
      {
        "id": 501,
        "label": "产品演示",
        "createTime": 1795046400000
      }
    ],
    "total": 1
  }
}
```

`list[].id` 为标签 ID，`label` 为名称，`createTime` 为毫秒时间戳。这里的查询字段 `label` 是名称，而素材登记中的 `label` 是逗号分隔的标签 ID 字符串，两者含义不同。

## 6. 创建视频发布任务

### `POST /v1/publish/videos`

对一个或多个账号创建视频发布任务。调用前确认目标账号处于 `authStatus=20`、服务仍有效，且视频地址可读取。

#### 幂等要求

必须携带 `Idempotency-Key`，长度不超过 64 个字符。一个键对应**整个批量请求**。

- 首次提交前生成唯一键，并保存键、完整请求体和各项 `clientTaskId`。
- 超时、连接中断或结果不明确时，使用原键和原请求体重试，不要更换键，也不要修改账号、素材、文案或数组顺序。
- 相同键和相同请求会返回首次处理结果；相同键用于不同请求会返回 `1007000110`。
- 服务返回“处理中”时等待后再查询或使用原请求恢复结果，不要立即创建另一批发布任务。
- `clientTaskId` 用于本地与远端任务关联，不能代替必填的幂等请求头。

本文不承诺幂等记录的具体保留时长。长时间无法确定受理结果时，应保留待核实状态并核对原任务，避免使用新键重复发布。

#### 请求体

请求体为对象数组，下表字段作用于每一项。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `accountId` | integer(int64) | 是 | 社媒账号 ID，来自账号查询接口 |
| `videoId` | integer(int64) | 二选一 | 已登记的视频素材 ID；与 `videoUrl` 至少提供一个，同时提供时优先使用 `videoId` |
| `videoUrl` | string | 二选一 | 公网视频文件地址；使用直链方式时填写 |
| `coverUrl` | string | 否 | 封面地址，无封面时可传 `""`；使用生成视频时优先使用生成结果的封面 |
| `title` | string | 是 | 发布标题或文案，需符合目标平台要求 |
| `description` | string | 否 | 描述，YouTube 平台生效 |
| `isAiGenerated` | integer | 否 | AI 生成标记：`0` 否、`1` 是，默认 `0`；按整数发送 |
| `clientTaskId` | string | 否 | 调用方为这一条发布记录分配的唯一 ID；创建成功后原样返回，建议每项都填写 |

批量请求中的每一项建议使用不同的 `clientTaskId`。例如同一视频发布到两个账号时，分别分配两个本地发布 ID，整个请求共用一个 `Idempotency-Key`。

本接口没有定时时间、时区或排期字段。**调用接口即开始创建发布任务；定时发布需由调用方保存排期，到期后再调用本接口。**

#### 方式 A：视频直链发布

以下使用 AI 生成视频或其他已有视频地址。缺少封面时不要求用户补齐封面。

```sh
curl "$BIAI_SOCIAL_BASE_URL/v1/publish/videos" \
  -X POST \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: publish-20261119-001" \
  --data '[
    {
      "accountId": 101,
      "videoUrl": "https://media.example.com/product-video.mp4",
      "coverUrl": "",
      "title": "产品演示视频",
      "isAiGenerated": 1,
      "clientTaskId": "content-20261119-001-tiktok"
    }
  ]'
```

#### 方式 B：素材 ID 发布

先使用素材登记接口取得 `videoId`。下面的 `102` 代表示例 YouTube 账号，需替换为自己查询到的账号。

```sh
curl "$BIAI_SOCIAL_BASE_URL/v1/publish/videos" \
  -X POST \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: publish-20261119-002" \
  --data '[
    {
      "accountId": 102,
      "videoId": 42802,
      "title": "产品演示视频",
      "description": "介绍产品的使用方式与实际场景。",
      "isAiGenerated": 1,
      "clientTaskId": "content-20261119-001-youtube"
    }
  ]'
```

#### 成功响应

```json
{
  "code": 0,
  "msg": "",
  "data": [
    {
      "id": "pub_example_001",
      "status": 10,
      "accountId": 101,
      "videoId": 42802,
      "videoUrl": "https://media.example.com/product-video.mp4",
      "title": "产品演示视频",
      "description": "",
      "createTime": 1795046400000,
      "clientTaskId": "content-20261119-001-tiktok",
      "remark": ""
    }
  ]
}
```

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | array | 发布任务结果数组，按 `clientTaskId` 关联本地记录，不只依赖数组位置 |
| `data[].id` | string | 发布任务 ID，后续状态查询使用此字段 |
| `data[].status` | integer | 发布任务状态，见下一节 |
| `data[].accountId` | integer(int64) | 目标账号 ID |
| `data[].videoId` | integer(int64) | 关联视频素材 ID |
| `data[].videoUrl` | string | 视频地址 |
| `data[].title` | string | 发布标题或文案 |
| `data[].description` | string | 描述，按实际返回值处理 |
| `data[].createTime` | integer(int64) | 任务创建时间，毫秒时间戳 |
| `data[].clientTaskId` | string | 对应请求项的本地任务 ID |
| `data[].remark` | string | 备注，可能为空 |

保存每个成功返回项的远端 `id`。后续查询使用这个发布任务 ID，不是 `videoId`，也不是 `clientTaskId`。

批量场景不要只读取 `data[0]`。逐项核对远端任务与本地 `clientTaskId` 的对应；若缺少预期返回项，保留待核实状态并使用原幂等请求恢复结果，不直接换新键补发。

## 7. 查询发布任务状态

### `GET /v1/publish/status`

#### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 创建发布任务时返回的远端发布任务 ID |

```sh
curl --get "$BIAI_SOCIAL_BASE_URL/v1/publish/status" \
  -H "Authorization: Bearer $BIAI_SOCIAL_ACCESS_TOKEN" \
  -H "Client-Id: $BIAI_SOCIAL_APP_ID" \
  -H "Content-Type: application/json" \
  --data-urlencode 'id=pub_example_001'
```

#### 发布状态

| `status` | 含义 | 调用方处理建议 |
| --- | --- | --- |
| `10` | 待发布 | 保存任务，继续查询 |
| `20` | 发布中 | 继续等待，不重复创建 |
| `30` | 发布完成 | 记录成功，停止常规轮询 |
| `40` | 发布失败 | 记录失败及服务返回的备注，停止常规轮询，核对原因后再决定是否新建任务 |
| `50` | 取消发布 | 记录已取消，停止常规轮询 |

该状态表描述服务返回值，不代表本文提供了取消接口。调用方尚未提交的本地排期可以自行取消；已提交任务不能仅删除本地记录就视为平台已取消。

建议处理中任务每 5～10 秒查询一次；这是调用方的轮询建议，不是接口承诺的频率上限。遇到限流时降低频率，并在服务返回 `Retry-After` 时遵循该值。遇到未知状态时保留原值并标记待核实，不应直接认定成功或创建新的发布任务。

本接口查询的是**社媒视频发布任务**，不用于查询 AI 图片或视频生成状态。

#### 成功响应

`data` 为单个任务对象，字段与创建发布响应中的单项相同：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "pub_example_001",
    "status": 30,
    "accountId": 101,
    "videoId": 42802,
    "videoUrl": "https://media.example.com/product-video.mp4",
    "title": "产品演示视频",
    "description": "",
    "createTime": 1795046400000,
    "clientTaskId": "content-20261119-001-tiktok",
    "remark": ""
  }
}
```

不要自行假定任务会返回社媒作品链接、播放量或粉丝数据；本文定义的返回字段不包含这些信息。

## 8. 错误处理与重试

### 8.1 HTTP 状态

| HTTP 状态 | 含义与处理建议 |
| --- | --- |
| `200` | 仍需检查 JSON 中的业务码 `code` |
| `400` | 检查参数结构、类型和必填字段 |
| `401` | 检查 Access Token 是否有效，以及是否与 App ID 配套 |
| `403` | 检查应用及账号操作权限 |
| `404` | 检查资源 ID、资源可见范围及请求地址 |
| `429` | 降低请求频率，按服务提示延迟重试 |
| `500` 等服务端错误 | 写请求受理结果可能不明确；发布请求保留原幂等键和请求体，不立即换键重发 |

### 8.2 常见业务码

| `code` | 说明与处理建议 |
| --- | --- |
| `0` | 本次接口调用成功；发布结果另看任务 `status` |
| `401` / `403` | 认证或权限问题，检查 App ID、Access Token 及授权 |
| `1007000110` | 幂等键已用于不同请求，核对原请求；不要将不同请求复用同一键 |
| `1007000111` | 操作处理中，等待并使用原请求恢复结果 |
| `1007000112` | 幂等操作失败，保留具体 `msg` 并核对原业务结果 |
| `1007000114` | `Idempotency-Key` 为空或长度超过 64 个字符 |
| `1005004000` | 视频已存在，先核对已保存的素材 ID 与地址关联 |
| `1005003000` | 依接口场景判断：标签创建可表示“视频标签已存在”，发布场景可表示任务超限；结合 `msg` 处理 |
| `1004800003` | 素材 ID 与素材 URL 不能同时为空 |
| `1004800004` | 素材资源未验证，核对素材与服务返回的信息 |
| `1004800005` | 素材 URL 无效，检查是否为可访问的视频文件地址 |
| `1004800006` | 素材不存在，核对素材 ID 与可见范围 |
| `1004800007` | 发布任务创建失败，查看具体 `msg`，保留本地业务记录 |
| `1004009017` | 发布账号不存在，重新查询当前凭证可见账号 |
| `1004008001` | 发布任务不存在，确认使用的是远端发布任务 ID |

错误码需要与具体接口和 `msg` 一起判断。页面可展示具体原因，长文本可截断摘要并提供完整详情；不要只显示“失败”而丢弃服务返回的信息。记录诊断信息时隐藏凭证。

区分两种情况：

- **请求失败**：HTTP 失败或业务 `code` 非 0。特别是超时、处理中和受理结果不明时，不能推定没有创建任务。
- **任务失败**：请求 `code=0`，但返回的发布任务 `status=40`。这是异步发布失败；保留任务及可用的 `remark`，核对后再决定是否创建新的尝试。

## 9. 推荐接入流程

### 9.1 立即发布

1. 配置配套的 App ID 与 Access Token，分页查询目标平台账号。
2. 仅选择 `authStatus=20` 且仍可发布的账号。
3. 取得有效的视频文件地址；如使用 AI 视频，先等生成成功并预览。封面使用生成结果地址，缺失时留空。
4. 选择直链发布，或先登记素材并保存视频 ID；需要标签时先创建或查询标签。
5. 展示目标账号、视频、标题、描述和 AI 生成标记，供用户确认。
6. 保存本地发布 ID、批次幂等键及完整请求体，调用发布接口。
7. 按 `clientTaskId` 关联返回项，保存远端发布任务 ID。
8. 轮询发布状态，达到完成、失败或取消状态后停止常规查询。

### 9.2 定时发布

这 6 个接口不包含定时发布字段。调用方可按以下方式实现：

1. 在本地保存发布草稿、目标账号、用户确认结果、时间和明确的时区，将执行时刻统一保存为时间戳。
2. 到期后重新检查账号授权、有效期与视频可访问性；签名链接失效时，在源服务仍保留文件的情况下取得新链接。
3. 确认视频可用后生成并保存本次提交的幂等键和最终请求体，再调用发布接口。
4. 一旦已经开始提交，同一业务重试保持该请求体不变。不要在结果不明时更换签名 URL、文案或幂等键后再次提交。
5. 持续查询发布状态。尚未提交的本地排期可以取消；已经提交的任务需要按服务实际能力处理。

签名 URL 的链接有效期与源视频文件保留期是不同概念。素材登记不会延长任一有效期。平台处理具有延迟，调用时间也不等同于作品精确公开时间。

### 9.3 调用方建议保存的信息

| 信息 | 用途 |
| --- | --- |
| 社媒账号 ID、平台及最近授权状态 | 选择与检查发布账号 |
| 源视频地址、可选封面及已知有效期 | 预览、提交前检查可用性 |
| 可选素材 ID、标签 ID | 复用已登记的素材与标签 |
| 本地 `clientTaskId`、批次幂等键和完整请求体 | 业务关联、恢复原请求、防止重复提交 |
| 远端发布任务 ID、状态和返回备注 | 状态查询与问题诊断 |
| 用户确认结果、可选排期时间及其时区 | 确认发布范围并在指定时刻提交 |

## 10. 常见问题

**接口凭证在哪里获取？**

前往 [Smart BIAI 官网](https://www.biaibiai.com/) 获取或申请社媒 App ID、Access Token 及相应权限。图片与视频生成服务的应用 API Key 不能代替社媒凭证。

**查询不到账号，或账号显示已授权仍不能发布？**

核对 App ID 与 Access Token 是否配套、账号是否在当前可见范围、分页是否读取完整，以及服务有效期和平台权限。只有 `authStatus=20` 可以进入发布流程，但它不是唯一的可发布条件。

**必须先调用视频素材登记接口吗？**

不必。发布接口支持 `videoUrl` 直链，也支持已登记的 `videoId`。同一项同时传入时优先使用 `videoId`；需要切换素材时先核对是否误带了旧 ID。

**登记素材后可以删除源视频或等待源链接过期吗？**

不可以据此假定视频已被存储。登记只保存记录，发布处理仍需要能够访问源视频。应确保源链接和源文件在处理期间有效。

**没有视频封面怎么办？**

封面可留空。使用生成服务返回的封面地址；没有时传 `coverUrl: ""`，不要求为发布额外生成封面。

**发布请求超时了，可以换一个幂等键再发吗？**

不要为同一次业务换键重发。先使用原键和原请求体恢复结果；已有远端任务 ID 时查询该任务。无法确认时保留待核实状态，避免重复发布。

**能通过 `clientTaskId` 直接查询发布状态吗？**

本文状态接口只接受远端任务 `id`。`clientTaskId` 用于创建响应与本地记录关联。若创建响应丢失，应使用原幂等请求恢复返回结果，而不是把 `clientTaskId` 当作远端 ID 查询。

**可以通过本文接口获取账号全部历史作品、播放量或发布图片吗？**

本文不提供这些接口。调用方可维护通过自身应用发起的发布记录；AI 图片生成能力见 [生成 API 文档](https://developer.biaibiai.com/docs)，不代表已经支持将图片直接发布到社媒。

## 11. 相关资源

- [Smart BIAI 官网与接入申请](https://www.biaibiai.com/)
- [Smart BIAI 图片与视频生成 API](https://developer.biaibiai.com/docs)
- [Smart BIAI Agent 开源项目](https://github.com/SmartBIAI/smart-biai-agent)
- [BIAI Agent 在线体验：模拟账号、创作与发布流程](https://developer.biaibiai.com/smart-biai-agent-static/)
