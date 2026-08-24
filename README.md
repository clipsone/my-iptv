# my-iptv（架构 B：GitHub 静态聚合 + 家庭动态源）

自建 IPTV 直播源项目。GitHub Actions 定时**抓取 → 去重归一 → 测速筛选 → 自动提交**生成干净的 m3u 播放列表；需要动态换址的平台源（咪咕 / B站体育等）交给家里常开设备上的自托管服务负责。

## 架构

```
┌─ GitHub Actions（每 6 小时）──────────────┐      ┌─ 家里常开设备 ─────────────────┐
│ scripts/aggregate.mjs                     │      │ akiralereal/iptv 自托管实例     │
│ 1. 拉取 sources.json 里的上游订阅          │      │ （Docker 一键部署，NAS 友好）    │
│ 2. 解析 m3u/txt → 名称归一 → 去重          │      │  负责动态源：实时换签名地址、    │
│ 3. 并发测速，剔除失效流                    │      │  token 续期、302 跳转           │
│ 4. 生成 output/iptv.m3u + report.json     │      └───────────────┬───────────────┘
│ 5. 有变化则自动 commit & push              │                      │
└──────────────────┬────────────────────────┘      公网可达时填进 sources.json
                   ↓                               的 homeSource.url 即可合并
   raw.githubusercontent.com/你/my-iptv/main/output/iptv.m3u
```

## 快速开始

1. 在 GitHub 新建仓库（或直接 push 本目录），确保默认分支为 `main`
2. 仓库 **Settings → Actions → General** 选择允许 Actions 运行
3. 到 **Actions** 页面手动触发一次 *Update IPTV Playlists*，确认跑通
4. 之后每 6 小时自动更新；订阅地址：

| 用途 | 地址 |
| --- | --- |
| 标准订阅 | `https://raw.githubusercontent.com/你的用户名/my-iptv/main/output/iptv.m3u` |
| 国内加速（jsDelivr 镜像） | `https://cdn.jsdelivr.net/gh/你的用户名/my-iptv@main/output/iptv.m3u` |
| 测速报告 | 查看 `output/report.json` |

## 配置 sources.json

| 字段 | 说明 |
| --- | --- |
| `subscriptions[]` | 上游 m3u / txt 订阅，`enabled: false` 可临时停用 |
| `customChannels[]` | 手动添加的固定直链频道 |
| `homeSource.url` | 家庭自托管实例的公网 `interface.m3u` 地址（需 DDNS/反代/frp 暴露），留空跳过 |
| `epgUrl` | EPG 节目单地址，写入 m3u 头部 |
| `timeoutMs` / `concurrency` / `maxProbe` / `maxUrlsPerChannel` | 测速参数（也可用环境变量 `TIMEOUT`/`CONCURRENCY`/`MAX_PROBE`/`MAX_PER_CH` 覆盖） |
| `dropKeywords` | 频道名含这些关键词的直接丢弃 |

同名频道最多保留 `maxUrlsPerChannel` 个地址，按测速结果排序 —— 播放器里即「源1 / 源2」；所有地址都失效的频道会被丢弃。

## 本地运行

```bash
node scripts/aggregate.mjs                          # 完整跑
MAX_PROBE=100 node scripts/aggregate.mjs            # 小规模快速验证
node --check scripts/aggregate.mjs                  # 语法检查
```

零 npm 依赖，Node 18+ 即可。

## 接入家庭动态源（体育赛事）

纯静态 m3u 放不住咪咕/B站这类带时效签名的直播地址，动态源请自托管
[akiralereal/iptv](https://github.com/akiralereal/iptv)：

```bash
# 家里 NAS / 旧电脑上
mkdir -p ~/iptv/data && cd ~/iptv
cat > docker-compose.yml <<'EOF'
services:
  iptv:
    image: akiralereal/iptv:latest
    container_name: iptv
    init: true
    ports: ["1905:1905"]
    environment:
      - mport=1905
    volumes:
      - ./data:/migu/data
    restart: always
EOF
docker compose up -d
```

然后二选一：

- **方式 A（推荐）**：给家庭实例配公网地址（DDNS / frp / 反代），把
  `http://你的域名:1905/interface.m3u` 填入本仓库 `sources.json` 的
  `homeSource.url` —— GitHub 聚合时会自动并入并统一测速排序；
- **方式 B**：播放器里同时添加两个订阅（本仓库的静态列表 + 家庭实例的
  `interface.m3u`），适合家庭服务不便公网暴露的情况。

## 常见问题

- **本地跑某个源拉取失败？** 部分国内源对海外/家宽网络有差异，GitHub Actions
  机房通常可达；以 `report.json` 里每个源的 ok 状态为准。
- **测速太严格，频道变少？** 这是特性：只保留实测可播的频道。可调大
  `TIMEOUT` 或在 `sources.json` 更换更稳的上游。
- **Actions 没跑？** Fork 后需手动到 Actions 页启用一次；公共仓库 Actions 免费。

## 免责声明

本项目仅做公开可访问播放链接的整理与测速，不存储、不分发任何音视频内容；
请遵守所在地法律法规及平台用户协议，勿用于商业用途。
