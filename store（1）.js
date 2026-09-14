/*
 * ★ 注释版说明（本文件是 store.js）★
 * 本文件相当于整个程序的“数据层 + 工具箱”：
 *   默认电网/市场主体模板、按典型日负荷生成 96 时段报价、浏览器本地存档、
 *   方案 JSON 导入导出、出清结果 CSV 导出。真正“算钱算电”的算法在 engine.js。
 * JS↔C++ 速查表请看 app.js 文件最开头的《注释版导读》。
 */
/* =========================================================================
 * 数据模型 · 典型日场景播种 · 持久化 · 导入导出
 *
 * 场景设定：三节点（北区电源基地 / 中区负荷中心 / 南区受端），
 * 4 家发电侧 + 3 家用电侧，日前市场 96 个时段（15 分钟一点）。
 * 报价随典型日负荷率浮动，高峰时段抬价，低谷时段降价。
 * ========================================================================= */
// 又是 IIFE，但它带了一个参数 root（最后一行调用时把“全局对象”传进来）。
// 好处：既能在浏览器里跑(全局对象是 window)，也能在 Node.js 里被测试文件 require。
// [C++] ≈ 把“环境句柄”显式传进一个立即执行的函数，避免直接依赖某个全局名字。
(function (root) {
  'use strict';

  // ══ 全局常量 ══
  // PERIODS=96：一天按 15 分钟切成 96 个时段（24 小时 × 4）。
  // STORAGE_KEY：在浏览器 localStorage 里存方案用的“键名”（相当于存档文件名）。
  // VERSION：数据版本号；以后数据结构改了可凭它判断旧存档还能不能用。
  const PERIODS = 96;                 // 24h × 15min
  const STORAGE_KEY = 'market-clearing-pro/state/v1';
  const VERSION = 1;

  /* ------------------------------------------------------- 时段与负荷曲线 */

  // 第 i 个时段对应的小时数（0 ~ 23.75）
  // periodHour(i)：把“第几个 15 分钟时段”换算成一天里的小时数（0 ~ 23.75）。
  // [C++] i % PERIODS ≈ 取模保证 i 永远在 0..95；*24/96 就是按比例换算。
  function periodHour(i) { return (i % PERIODS) * 24 / PERIODS; }

  // "08:30" 形式
  // periodLabel(i)：把时段换算成 "HH:MM" 时刻文本（如第 78 时段 → "19:30"）。
  // [C++] Math.floor ≈ 向下取整；Math.round ≈ 四舍五入；
  //       String.padStart(2,'0') ≈ 不足 2 位前面补 '0'（如 8 → "08"）。
  function periodLabel(i) {
    const h = periodHour(i);
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // 典型日负荷率：早晚双高峰，凌晨低谷
  // loadFactor(t)：一天里某时刻的“典型负荷率”。
  // 用 3 条高斯曲线叠加模拟：早高峰 10.5 点、晚高峰 19.5 点、凌晨 4 点低谷。
  // [C++] g(c,w)=exp(-((t-c)/w)^2) ≈ 标准正态钟形曲线：t 越靠近 c 值越大。
  function loadFactor(t) {
    const g = (c, w) => Math.exp(-Math.pow((t - c) / w, 2));
    return 0.68 + 0.12 * g(10.5, 2.0) + 0.24 * g(19.5, 2.5) - 0.10 * g(4.0, 2.2);
  }

  const F_MIN = 0.58, F_MAX = 0.92;   // 负荷率大致区间，用于归一化

  // 归一化负荷率 0~1
  // normalizedLoad(i)：把负荷率“线性归一化”到 0~1，并夹在 [0,1] 内。
  // (f-F_MIN)/(F_MAX-F_MIN)：把 0.58~0.92 映射成 0~1；Math.min/max 负责越界截断。
  // app.js 的“复制到高峰时段”就是用它判断哪些时段算高峰(≥0.6)。
  function normalizedLoad(i) {
    const f = loadFactor(periodHour(i));
    return Math.min(1, Math.max(0, (f - F_MIN) / (F_MAX - F_MIN)));
  }

  /* ------------------------------------------------------- 默认网络 */
  // defaultNetwork()：返回“三节点电网”的默认拓扑对象。
  //   nodes：母线列表（每个有 id/name/desc）；
  //   lines：输电线路（每条有 电抗 x 和 容量 cap，单位约为标幺值/MW）；
  //   slackId：平衡节点 —— LMP 计算中作为“能量分量”的参考点。
  //   enabled：是否考虑网络约束（关掉就是全网统一边际电价，等于忽略线路容量）。
  function defaultNetwork() {
    return {
      enabled: true,            // 是否考虑网络约束（关掉即全网统一价）
      slackId: 'N',             // 平衡节点（北区电源基地，LMP 以此为能量分量基准）
      nodes: [
        { id: 'N', name: '北区', desc: '电源基地：煤电 + 风电' },
        { id: 'C', name: '中区', desc: '负荷中心：工业与居民' },
        { id: 'S', name: '南区', desc: '受端电网：商业负荷 + 燃气调峰' },
      ],
      lines: [
        { id: 'L1', name: '北电南送一线', from: 'N', to: 'C', x: 0.08, cap: 260 },
        { id: 'L2', name: '中南联络线', from: 'C', to: 'S', x: 0.10, cap: 320 },
        { id: 'L3', name: '南北迂回线', from: 'N', to: 'S', x: 0.20, cap: 160 },
      ],
    };
  }

  /* ------------------------------------------------------- 市场主体模板 */
  // gens: 容量固定，报价随负荷率浮动（模拟燃料与启停成本变化）
  // cons: 电力随负荷率变化，报价亦随之浮动
  // TEMPLATE：7 个“市场主体的默认档案（模板）”。字段含义：
  //   side    'gen'=发电侧 / 'con'=用电侧；node  挂在哪个节点；
  //   bidMode 'step' 阶梯报价 / 'quadratic' 二次曲线报价；
  //   segments 阶梯报价的若干段：{ power: 本段电力增量(MW), price: 本段价格(元/MWh) }；
  //   quad    二次曲线系数（P = aQ² + bQ + c）、最大出力 qMax、离散段数 steps。
  // 注意这只是模板；真正运行时 createDefaultState → seedBids 会给每个主体
  // 生成“96 个时段各自独立的报价”。
  const TEMPLATE = [
    {
      id: 'gen1', name: '华能北电厂', short: '华能', side: 'gen', node: 'N',
      enabled: true, bidMode: 'step',
      segments: [{ power: 150, price: 300 }, { power: 150, price: 360 }, { power: 100, price: 440 }],
      color: '#2563eb',
    },
    {
      id: 'gen2', name: '大唐中电厂', short: '大唐', side: 'gen', node: 'C',
      enabled: true, bidMode: 'quadratic',
      quad: { a: 0.0004, b: 0.30, c: 250, qMax: 350, steps: 120 },
      color: '#0891b2',
    },
    {
      id: 'gen3', name: '国电南燃气', short: '国电', side: 'gen', node: 'S',
      enabled: true, bidMode: 'step',
      segments: [{ power: 120, price: 430 }, { power: 120, price: 530 }],
      color: '#7c3aed',
    },
    {
      id: 'gen4', name: '国投北风电', short: '风电', side: 'gen', node: 'N',
      enabled: true, bidMode: 'step',
      segments: [{ power: 100, price: 120 }],
      color: '#059669',
    },
    {
      id: 'con1', name: '工业用户A', short: '工业', side: 'con', node: 'C',
      enabled: true, bidMode: 'step',
      segments: [{ power: 180, price: 620 }, { power: 120, price: 500 }, { power: 80, price: 380 }],
      color: '#d97706',
    },
    {
      id: 'con2', name: '商业用户B', short: '商业', side: 'con', node: 'S',
      enabled: true, bidMode: 'step',
      segments: [{ power: 150, price: 660 }, { power: 100, price: 520 }],
      color: '#db2777',
    },
    {
      id: 'con3', name: '居民用户C', short: '居民', side: 'con', node: 'C',
      enabled: true, bidMode: 'step',
      segments: [{ power: 120, price: 640 }, { power: 90, price: 460 }],
      color: '#dc2626',
    },
  ];

  // r2：四舍五入到 2 位小数的工具（浮点数计算常产生 0.30000000004 这种尾巴）。
  const r2 = v => Math.round(v * 100) / 100;

  /* ------------------------------------------------------- 生成 96 时段报价 */
  // ══ seedBids(tpl)：按模板 tpl 生成该主体 96 个时段的报价数组 ══
  // 核心思路：让“报价随一天里的负荷高低浮动”——高峰时段更贵、低谷更便宜。
  function seedBids(tpl) {
    const bids = [];
    for (let i = 0; i < PERIODS; i++) {
      const n = normalizedLoad(i);
      if (tpl.side === 'gen') {
        // 发电侧：容量固定，报价随系统负荷率上浮 0.90 ~ 1.15
        const k = 0.90 + 0.25 * n;
        // 每个时段存一个“报价对象”。发电侧二次曲线方式：把系数 a,b,c 整体乘上
        // 放大系数 k（k 随负荷率从 0.90 涨到 1.15），容量 qMax 不变。
        if (tpl.bidMode === 'quadratic') {
          bids.push({
            bidMode: 'quadratic',
            quad: {
              a: r2(tpl.quad.a * k),
              b: r2(tpl.quad.b * k),
              c: r2(tpl.quad.c * k),
              qMax: tpl.quad.qMax,
              steps: tpl.quad.steps || 120,
            },
            segments: [],
          });
        } else {
          bids.push({
            bidMode: 'step',
            segments: tpl.segments.map(s => ({ power: s.power, price: Math.round(s.price * k) })),
            quad: null,
          });
        }
      // 用电侧（else 分支）：连“申报的电力”也随负荷曲线伸缩(f)，
      // 价格再乘浮动系数 k —— 模拟用户高峰多用、低谷少用。
      } else {
        // 用电侧：电力随负荷曲线变化，报价同步浮动 0.92 ~ 1.12
        const f = loadFactor(periodHour(i)) / 0.75;
        const k = 0.92 + 0.20 * n;
        bids.push({
          bidMode: 'step',
          segments: tpl.segments.map(s => ({
            power: r2(s.power * f),
            price: Math.round(s.price * k),
          })),
          quad: null,
        });
      }
    }
    return bids;
  }

  /* ------------------------------------------------------- 初始状态 */
  // ══ createDefaultState()：生成一份“全新的默认方案”，app.js 首次打开用它 ══
  // 返回一个完整 state：meta(说明/时间)、options(离散段数)、network(电网)、
  // participants(7 个主体的运行时状态，每个都带 96 时段的报价 bids)。
  function createDefaultState() {
    return {
      version: VERSION,
      meta: {
        title: '电力现货市场出清仿真平台',
        scenario: '三节点 · 96 时段日前市场',
        createdAt: new Date().toISOString(),
      },
      options: { quadSteps: 120 },
      network: defaultNetwork(),
      // TEMPLATE.map(主体 => …)：遍历模板数组，把每个模板“复制”成运行时主体。
      // [C++] ≈ for 循环遍历 vector，逐个生成“模板的实例副本”。
      participants: TEMPLATE.map(t => ({
        id: t.id, name: t.name, short: t.short, side: t.side, node: t.node,
        color: t.color, enabled: t.enabled,
        bidMode: t.bidMode,
        // segments/quad 用 JSON 深拷贝再存：防止多个主体/多次创建时共享同一块对象，
        // 那样会“改一个、全跟着变”。bids 则用 seedBids 现生成（每个主体独立）。
        segments: JSON.parse(JSON.stringify(t.segments || [])),
        quad: t.quad ? JSON.parse(JSON.stringify(t.quad)) : { a: 0, b: 0.3, c: 250, qMax: 300, steps: 120 },
        bids: seedBids(t),
      })),
    };
  }

  /* ------------------------------------------------------- 持久化 */
  // ══ 持久化：浏览器本地存档（localStorage）══
  // save(state)：把整个方案序列化成 JSON 字符串后存入浏览器本地。
  // [C++] localStorage ≈ 浏览器提供的“小硬盘”（键值对），关掉网页数据仍在。
  // app.js 里是“防抖 600ms 后自动调它”，避免频繁写入。
  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('保存失败', e);
      return false;
    }
  }

  // load()：读取上次保存的方案；没有存档/版本不对/结构不对都返回 null，
  // 调用方(app.js)收到 null 就用 createDefaultState() 建默认方案。
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s && s.version === VERSION && Array.isArray(s.participants)) ? s : null;
    } catch (e) {
      return null;
    }
  }

  // clear()：删除本地存档（“清空本地缓存”按钮会调用它）。
  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- 导入导出 */
  // serialize(state)：把 state 序列化成“带 2 空格缩进”的 JSON 文本（人眼可读）。
  // [C++] JSON.stringify(state, null, 2) ≈ 把对象“打印”成结构化字符串。
  function serialize(state) {
    return JSON.stringify(state, null, 2);
  }

  // deserialize(text)：把 JSON 文本解析回 state，并做三道“体检”：
  // 缺 participants / network.nodes / 首主体 bids 都会直接抛异常（调用方会提示导入失败）。
  // 校验通过后补上 version 再返回。
  function deserialize(text) {
    const s = JSON.parse(text);
    if (!s || !Array.isArray(s.participants)) throw new Error('文件格式不正确：缺少 participants');
    if (!s.network || !Array.isArray(s.network.nodes)) throw new Error('文件格式不正确：缺少 network.nodes');
    if (!Array.isArray(s.participants[0].bids)) throw new Error('文件格式不正确：缺少分段报价 bids');
    s.version = VERSION;
    return s;
  }

  // download(filename, content, mime)：触发浏览器“下载一个文件”。
  // 原理：把内容塞进 Blob → 生成临时 URL → 造一个隐藏 <a> 点一下 → 1 秒后释放 URL。
  // [C++] 没有直接对应物；可理解为“让浏览器弹出一个保存文件对话框”。
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // exportJSON：把“整个方案”下载成 JSON 文件（答辩前存档用）。
  function exportJSON(state) {
    download('电力现货市场_方案_' + stamp() + '.json', serialize(state), 'application/json;charset=utf-8');
  }

  // 出清结果导出为 CSV（含 BOM，Excel 直接打开不乱码）
  // ══ exportCSV：把 96 时段出清结果导出成一张 CSV 表（Excel 可直接打开）══
  function exportCSV(state, results) {
    const nodes = state.network.nodes;
    const lines = state.network.lines;
    // 先拼表头：固定列(时段/时间/电量/价格/是否阻塞) + 每个节点一列 LMP
    // + 每条线路一列潮流 + 最后一列阻塞盈余。
    const head = ['时段', '时间', '出清电量(MW)', '系统边际电价(元/MWh)', '是否阻塞'];
    nodes.forEach(n => head.push('LMP_' + n.name + '(元/MWh)'));
    lines.forEach(l => head.push('潮流_' + l.name + '(MW)'));
    head.push('阻塞盈余(元)');

    // 每个“成功出清”的时段生成一行；r.lmp[n.id] 取不到时退回全网统一价 r.energy。
    const rows = [head];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.ok) continue;
      const row = [i + 1, periodLabel(i), r.qty.toFixed(2), r.price.toFixed(2), r.congested ? '是' : '否'];
      nodes.forEach(n => row.push((r.lmp[n.id] !== undefined ? r.lmp[n.id] : r.energy).toFixed(2)));
      lines.forEach((l, li) => row.push((r.flows[li] || 0).toFixed(2)));
      row.push(r.rent.toFixed(2));
      rows.push(row);
    }
    // 拼 CSV 文本：开头加 '﻿'(BOM) 让 Excel 不乱码；
    // 字段里若含逗号/引号/换行，就用双引号包起来并把内部引号转义(""→"")。
    const csv = '\uFEFF' + rows.map(r => r.map(c => {
      const s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    download('电力现货市场_出清结果_' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
  }

  // 各市场主体 96 时段中标明细
  // ══ exportAwardCSV：导出“每个主体每个时段”的中标明细（一张更细的表）══
  function exportAwardCSV(state, results) {
    const head = ['时段', '时间', '主体', '角色', '节点', '申报量(MW)', '中标量(MW)', '结算电价(元/MWh)', '金额(元)'];
    const rows = [head];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.ok) continue;
      // 把发电明细(记收入 income)和用电明细(记支出 payment)合并成一个列表，逐条输出一行。
      const all = r.genDetail.map(d => ({ d, role: '发电侧', amt: d.income }))
        .concat(r.conDetail.map(d => ({ d, role: '用电侧', amt: d.payment })));
      for (const it of all) {
        rows.push([
          i + 1, periodLabel(i), it.d.name, it.role, nodeName(state, it.d.node),
          it.d.bidQty.toFixed(2), it.d.awarded.toFixed(2), it.d.price.toFixed(2), it.amt.toFixed(2),
        ]);
      }
    }
    const csv = '\uFEFF' + rows.map(r => r.map(c => {
      const s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    download('电力现货市场_中标明细_' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
  }

  // nodeName(state, id)：把节点 id 翻译成中文名（找不到就原样显示 id）。
  function nodeName(state, id) {
    const n = (state.network.nodes || []).find(x => x.id === id);
    return n ? n.name : id;
  }

  // stamp()：生成“当前时间戳”字符串（如 20260909_1530），用来拼在导出文件名里。
  function stamp() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  // ══ 导出公共接口 ══
  // 把本文件里的常量和函数全部挂到 root.MarketStore 上 ——
  // [C++] ≈ 这个 .js 文件的“头文件/公共接口”：别的文件通过 window.MarketStore 调用。
  root.MarketStore = {
    PERIODS, VERSION, STORAGE_KEY,
    periodHour, periodLabel, loadFactor, normalizedLoad,
    defaultNetwork, TEMPLATE, createDefaultState,
    save, load, clear,
    serialize, deserialize, download,
    exportJSON, exportCSV, exportAwardCSV, nodeName, stamp,
  };

  // 若在 Node.js 环境运行（module 存在），也导出 MarketStore，
  // 这样 engine.test.js / mount.test.js 等测试文件才能 require('./store.js')。
  if (typeof module === 'object' && module.exports) module.exports = root.MarketStore;
// IIFE 收尾：把“全局对象”传给 root。
// 浏览器里 self===window；Node 里用 this。这就是第 8 行那个参数的来源。
})(typeof self !== 'undefined' ? self : this);
