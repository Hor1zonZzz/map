# 华夏舆图 · 省市区县下钻版

## 当前数据方案

- 运行时不再直接请求第三方边界 API。
- 边界数据通过 `scripts/build-boundaries.mjs` 预先下载到本地静态文件。
- 前端运行时只加载 `data/boundaries/*.js`，按 `省 -> 市 -> 区县` 逐级懒加载。

## 数据来源

- 原始边界接口：`https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json`
- 当前项目把这套接口当作“生成本地边界镜像”的上游，不再当作运行时依赖。
- 生成后的来源说明会写入 `data/boundary-manifest.js`。

## 目录结构

- `data/boundary-manifest.js`
  记录生成时间、上游来源、文件数量。
- `data/statistical-regions.js`
  国家统计局四大地区口径映射表：东部 / 中部 / 西部 / 东北。
- `data/boundaries/100000_full.js`
  全国省级边界。
- `data/boundaries/<省adcode>_full.js`
  省级下的市级边界。
- `data/boundaries/<市adcode>_full.js`
  市级下的区县边界。

## 更新数据

```bash
node scripts/build-boundaries.mjs
```

## 说明

- V1 叶子层停在区县级，不继续拆到乡镇街道。
- 旧的手写“城市等级 / tier”数据已移除，避免和新的行政区划数据混用。
- 国家统计局四大地区映射仅覆盖大陆 31 个省级行政区；香港、澳门、台湾在该口径下单独标记为未纳入。
