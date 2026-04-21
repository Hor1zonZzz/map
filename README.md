# 华夏舆图 · 掷签问地

一张离线可用的中国行政区划地图，用于"旅游博主掷飞镖选目的地"玩法：

- 边界：DataV / 高德 开放接口的本地镜像（省 → 市 → 区县）
- POI：OpenStreetMap 全量点位，按叶子区县分片离线烘焙
- 掷签：在当前叶子区县内**等权随机**抽取一条 OSM POI；POI 未覆盖时回退到区县几何随机点

前端是纯静态站（D3 + turf），可以直接托管到 GitHub Pages。

## 目录结构

```
index.html                前端页面（GitHub Pages 入口）
app.js                    前端逻辑
styles.css                视觉样式
src/destination-core.mjs  掷签选点纯逻辑（有单元测试）

data/boundaries/*.js      行政区划边界分片（已提交）
data/boundary-manifest.js 边界分片清单
data/statistical-regions.js  国家统计局四大地区口径
data/pois/<adcode>.js     OSM POI 分片（懒加载，需自行烘焙）
data/pois-manifest.js     POI 分片清单
data/.pois-build/         build-pois.mjs 产出的 backfill 中间产物
data/.regeo-progress.json 高德 regeo 断点续传记录

scripts/build-boundaries.mjs     抓取/刷新边界数据
scripts/build-pois.mjs           OSM GeoJSON → 区县分片
scripts/fill-chinese-names.mjs   用高德 regeo 补 name:zh

tests/destination-core.test.mjs  掷签选点的单元测试
```

## 数据流

```
边界：DataV API ──► scripts/build-boundaries.mjs ──► data/boundaries/*.js
                                                   └► data/boundary-manifest.js

POI： Geofabrik PBF ──► osmium 预处理 ──► data/raw/pois.geojsonseq
                                                   │
                                                   ▼
                                     scripts/build-pois.mjs
                                                   │ 空间相交 rbush + turf
                                                   ▼
                          data/pois/<adcode>.js ・ data/.pois-build/*.json
                                                   │
                                     scripts/fill-chinese-names.mjs（可选）
                                                   │ 高德 regeo 回填 name:zh
                                                   ▼
                          data/pois/<adcode>.js  ・ data/pois-manifest.js
```

## 快速开始

```bash
npm install
# 启动任意静态服务器即可预览
python3 -m http.server 8000
```

浏览器打开 <http://localhost:8000>。若还没烘焙 POI 数据，掷签会自动回退到"区县内几何随机点"，UI 不会报错。

## GitHub Pages 部署

仓库默认**不提交** `data/pois/`，而是把它作为"部署专用资产"单独上传到固定 Release tag `pages-data`。GitHub Actions 在构建 Pages artifact 时会下载这个资产、解包到 `dist/data/pois/`，这样主分支保持轻量，但线上仍然提供按区县懒加载的真实 POI。

首次配置 / 每次更新 POI 时：

```bash
# 1. 本地生成或刷新 shard
npm run build:pois

# 2. 打包部署专用 POI 资产（输出 .deploy/pages-pois.tar.gz）
npm run package:pages-pois

# 3. 上传到固定 Release tag: pages-data
npm run publish:pages-pois
```

之后正常推送代码即可：

```bash
git push origin main
```

推送后，`.github/workflows/deploy-pages.yml` 会：
1. 用仓库代码构建静态站 artifact
2. 从 Release tag `pages-data` 下载 `pages-pois.tar.gz`
3. 解包到 `dist/data/pois/`
4. 上传 Pages artifact 并部署

注意：
- 如果你只改了前端代码、没改 POI 数据，只需要 `git push`。
- 如果你改了 `data/pois/` 或重新跑了 `build:pois`，要先重新执行 `npm run package:pages-pois` 和 `npm run publish:pages-pois`，再推代码。
- `pages-data` 是部署专用 Release，不影响运行时请求路径；线上仍然只从 GitHub Pages 站点请求 `data/pois/<adcode>.js`。

## 刷新 / 重建数据

### 边界

```bash
npm run build:boundaries
```

不常改，DataV 接口变动时跑一次即可。

### POI（首次烘焙 / 刷新）

一次性下载 OSM 中国全量数据、提取 POI、按区县分片。前端运行时只会在命中某个叶子区县时请求对应 `data/pois/<adcode>.js`，不会首屏预取全国数据。

```bash
# 0. 安装 osmium-tool（本地一次）
brew install osmium-tool   # macOS；Debian 系：apt install osmium-tool

# 1. 下载中国 PBF（~1.5 GB，Geofabrik 免费镜像）
mkdir -p data/raw
curl -L -o data/raw/china-latest.osm.pbf \
  https://download.geofabrik.de/asia/china-latest.osm.pbf

# 2. 只保留带 name 的 node 和 way
osmium tags-filter data/raw/china-latest.osm.pbf \
  n/name w/name \
  -o data/raw/named.osm.pbf

# 3. 导出 GeoJSONSeq（osmium export --add-unique-id=type_id 保留稳定 OSM id）
osmium export data/raw/named.osm.pbf \
  --add-unique-id=type_id \
  -f geojsonseq \
  -o data/raw/pois.geojsonseq

# 4. 按叶子区县分片（结果在 data/pois/）
npm run build:pois
```

产物：
- `data/pois/<adcode>.js` — 运行时按区县懒加载的分片
- `data/pois-manifest.js` — 轻量清单（前端启动时读取）
- `data/.pois-build/<adcode>.json` — 回填脚本用的中间 stash（git 忽略）

前端加载逻辑（`app.js`）：
1. 启动时只加载 `data/pois-manifest.js`，不预取全量 POI
2. 掷签命中叶子区县时，检查该 adcode 是否存在分片
3. 若存在，就通过 `<script>` 懒加载 `data/pois/<adcode>.js`
4. 同一分片在当前页面内只会加载一次；浏览器缓存命中时后续访问也不会重复下载
5. 若分片缺失或加载失败，则回退到“区县内几何随机点”

部署提示：
- 如果你要托管到 GitHub Pages，仓库内置的 workflow 会在部署时自动把 Release tag `pages-data` 中的 `pages-pois.tar.gz` 解包进最终 artifact。
- 如果你要托管到其它静态站，部署产物里同样必须包含 `data/pois/` 目录。

### 补齐缺失的中文名

> ⚠️ **当前实现质量不可用，默认不要跑**。说明见下文「已知问题」一节。

OSM 给的是「最近的高德 POI」，不是"翻译这条 POI 的名字"——两边的 POI 库不重合时，会把 `Guxiang 20`（古巷酒吧 20 号）补成几百米外的「文化部宿舍」，地理上不对应。**保留 OSM 英文/拼音原名比 backfill 更安全。**

如果将来要重做，正确思路是用 `place/text` 拿英文名做关键词搜索 + 距离排序，不是 `regeo`。

脚本本身仍保留作为参考：

```bash
# 高德免费 Web 服务 key（https://lbs.amap.com）
export AMAP_KEY=your_key_here

# 可选环境变量
export AMAP_DAILY_BUDGET=4800   # 默认 4800，给每日 5000 留一点余量
export AMAP_QPS=2               # 默认 2，低于高德的 3 QPS 限制

npm run fill:chinese-names
```

- 支持断点续传（`data/.regeo-progress.json` 记录已处理的 POI id 和今日用量）
- 每日配额用完后会自动停止；隔天再跑继续
- 只会重写**实际发生变更**的分片，其它分片保持原样

## 前端数据接口

前端通过几个全局变量读取数据：

- `window.__BOUNDARY_DATA__[adcode]` — 区划 GeoJSON（懒加载，边界 .js 文件自行注册）
- `window.__BOUNDARY_MANIFEST__` — 边界清单
- `window.__POI_MANIFEST__` — POI 分片清单（`{ totalPois, shards: { [adcode]: { count, missingZh } } }`）
- `window.__POI_SHARDS__[adcode]` — 懒加载的 POI 数组，每条：`{ id, name, lng, lat, kind }`

掷签时 `app.js` 中的 `loadPoiShard` 通过 `<script>` 标签注入对应分片（与边界一致的加载模式，兼容 GitHub Pages 静态托管）。

## 测试

```bash
npm test
```

覆盖 `src/destination-core.mjs` 的掷签核心逻辑（权重、命中、回退）。

## 数据来源与许可

- 行政区划：[阿里云 DataV.GeoAtlas](https://datav.aliyun.com/portal/school/atlas/area_selector) / 高德开放平台，仅供学习交流使用。
- POI：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。使用时需保留归属声明，前端页脚已内置。
- 中文名补齐：[高德 Web 服务 API](https://lbs.amap.com/api/webservice/guide/api/georegeo)，走 key 鉴权，受免费配额限制。

## 注意

- 本仓库不提交 OSM PBF 原始数据和 `data/raw/`（体积大），请按上文命令自行生成。
- POI 数据 ODbL 要求"改编作品同样开放"：如果你对 POI 做了大量二次清洗，请把清洗后的产物以 ODbL 或兼容许可开放。
- 纯随机掷签在荒野（戈壁、湖心、无人区）也会命中——这是设计意图，不是 bug；这些区域的 OSM POI 本来就稀疏。

## 已知问题

### `fill-chinese-names.mjs` 当前回填策略不可用

走的是高德 `geocode/regeo`，按经纬度找半径 200 m 内**最近的高德 POI**，而不是查询同一个 POI 的中文名。当 OSM 与高德的 POI 库不重合时（很常见），脚本会把"Guxiang 20"补成「文化部宿舍」、把"Regent Beijing"补成「北京 apm」——地理上指向完全不同的店，对旅游博主来说是有害信息。

**已经实测过 100 次调用，命中率 100%，但准确率约 0%**。当前数据已回滚到不补齐的状态。约 10 万条（占总量 2.3%）保持英文/拼音原值，等未来用 `place/text` 关键词搜索+距离排序的方案重做。
