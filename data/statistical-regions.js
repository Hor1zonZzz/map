// 国家统计局四大地区划分
// 来源：国家统计局《2025年1—4月份全国固定资产投资增长4.0%》
// 成文日期：2025-05-19
// 附注4写明：
// 东部地区包括北京、天津、河北、上海、江苏、浙江、福建、山东、广东、海南；
// 中部地区包括山西、安徽、江西、河南、湖北、湖南；
// 西部地区包括内蒙古、广西、重庆、四川、贵州、云南、西藏、陕西、甘肃、青海、宁夏、新疆；
// 东北地区包括辽宁、吉林、黑龙江。

window.__STATISTICAL_REGION_SCHEME__ = {
  scheme: 'nbs-east-central-west-northeast',
  label: '国家统计局四大地区划分',
  source: {
    organization: '国家统计局',
    title: '2025年1—4月份全国固定资产投资增长4.0%',
    date: '2025-05-19',
    url: 'https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202505/t20250519_1959860.html',
    note: '附注4：东、中、西部和东北地区划分',
  },
  regionOrder: ['eastern', 'central', 'western', 'northeastern'],
  regions: {
    eastern: {
      key: 'eastern',
      name: '东部地区',
      provinceCodes: [
        '110000', '120000', '130000', '310000', '320000',
        '330000', '350000', '370000', '440000', '460000',
      ],
      provinceNames: [
        '北京市', '天津市', '河北省', '上海市', '江苏省',
        '浙江省', '福建省', '山东省', '广东省', '海南省',
      ],
    },
    central: {
      key: 'central',
      name: '中部地区',
      provinceCodes: [
        '140000', '340000', '360000', '410000', '420000', '430000',
      ],
      provinceNames: [
        '山西省', '安徽省', '江西省', '河南省', '湖北省', '湖南省',
      ],
    },
    western: {
      key: 'western',
      name: '西部地区',
      provinceCodes: [
        '150000', '450000', '500000', '510000', '520000', '530000',
        '540000', '610000', '620000', '630000', '640000', '650000',
      ],
      provinceNames: [
        '内蒙古自治区', '广西壮族自治区', '重庆市', '四川省', '贵州省', '云南省',
        '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
      ],
    },
    northeastern: {
      key: 'northeastern',
      name: '东北地区',
      provinceCodes: ['210000', '220000', '230000'],
      provinceNames: ['辽宁省', '吉林省', '黑龙江省'],
    },
  },
  provinceMap: {
    '110000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '北京市' },
    '120000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '天津市' },
    '130000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '河北省' },
    '140000': { regionKey: 'central', regionName: '中部地区', provinceName: '山西省' },
    '150000': { regionKey: 'western', regionName: '西部地区', provinceName: '内蒙古自治区' },
    '210000': { regionKey: 'northeastern', regionName: '东北地区', provinceName: '辽宁省' },
    '220000': { regionKey: 'northeastern', regionName: '东北地区', provinceName: '吉林省' },
    '230000': { regionKey: 'northeastern', regionName: '东北地区', provinceName: '黑龙江省' },
    '310000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '上海市' },
    '320000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '江苏省' },
    '330000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '浙江省' },
    '340000': { regionKey: 'central', regionName: '中部地区', provinceName: '安徽省' },
    '350000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '福建省' },
    '360000': { regionKey: 'central', regionName: '中部地区', provinceName: '江西省' },
    '370000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '山东省' },
    '410000': { regionKey: 'central', regionName: '中部地区', provinceName: '河南省' },
    '420000': { regionKey: 'central', regionName: '中部地区', provinceName: '湖北省' },
    '430000': { regionKey: 'central', regionName: '中部地区', provinceName: '湖南省' },
    '440000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '广东省' },
    '450000': { regionKey: 'western', regionName: '西部地区', provinceName: '广西壮族自治区' },
    '460000': { regionKey: 'eastern', regionName: '东部地区', provinceName: '海南省' },
    '500000': { regionKey: 'western', regionName: '西部地区', provinceName: '重庆市' },
    '510000': { regionKey: 'western', regionName: '西部地区', provinceName: '四川省' },
    '520000': { regionKey: 'western', regionName: '西部地区', provinceName: '贵州省' },
    '530000': { regionKey: 'western', regionName: '西部地区', provinceName: '云南省' },
    '540000': { regionKey: 'western', regionName: '西部地区', provinceName: '西藏自治区' },
    '610000': { regionKey: 'western', regionName: '西部地区', provinceName: '陕西省' },
    '620000': { regionKey: 'western', regionName: '西部地区', provinceName: '甘肃省' },
    '630000': { regionKey: 'western', regionName: '西部地区', provinceName: '青海省' },
    '640000': { regionKey: 'western', regionName: '西部地区', provinceName: '宁夏回族自治区' },
    '650000': { regionKey: 'western', regionName: '西部地区', provinceName: '新疆维吾尔自治区' },
  },
  excludedProvinceMap: {
    '710000': { reason: '国家统计局四大地区口径未纳入台湾地区', provinceName: '台湾省' },
    '810000': { reason: '国家统计局四大地区口径未纳入香港特别行政区', provinceName: '香港特别行政区' },
    '820000': { reason: '国家统计局四大地区口径未纳入澳门特别行政区', provinceName: '澳门特别行政区' },
  },
};
