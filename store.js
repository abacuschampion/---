/* =========================================================================
 * 数据模型 · 典型日场景播种 · 持久化 · 导入导出
 *
 * 场景设定：三节点（北区电源基地 / 中区负荷中心 / 南区受端），
 * 4 家发电侧 + 3 家用电侧，日前市场 96 个时段（15 分钟一点）。
 * 报价随典型日负荷率浮动，高峰时段抬价，低谷时段降价。
 * ========================================================================= */
(function (root) {
  'use strict';

  const PERIODS = 96;                 // 24h × 15min
  const STORAGE_KEY = 'market-clearing-pro/state/v1';
  const VERSION = 1;

  /* ------------------------------------------------------- 时段与负荷曲线 */

  // 第 i 个时段对应的小时数（0 ~ 23.75）
  function periodHour(i) { return (i % PERIODS) * 24 / PERIODS; }

  // "08:30" 形式
  function periodLabel(i) {
    const h = periodHour(i);
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // 典型日负荷率：早晚双高峰，凌晨低谷
  function loadFactor(t) {
    const g = (c, w) => Math.exp(-Math.pow((t - c) / w, 2));
    return 0.68 + 0.12 * g(10.5, 2.0) + 0.24 * g(19.5, 2.5) - 0.10 * g(4.0, 2.2);
  }

  const F_MIN = 0.58, F_MAX = 0.92;   // 负荷率大致区间，用于归一化

  // 归一化负荷率 0~1
  function normalizedLoad(i) {
    const f = loadFactor(periodHour(i));
    return Math.min(1, Math.max(0, (f - F_MIN) / (F_MAX - F_MIN)));
  }

  /* ------------------------------------------------------- 默认网络 */
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

  const r2 = v => Math.round(v * 100) / 100;

  /* ------------------------------------------------------- 生成 96 时段报价 */
  // 把"主体模板"展开为 96 个时段的报价数组 bids[0..95]，
  // 每个时段报价受归一化负荷率 normalizedLoad(i) 影响：
  //   - 发电侧：容量固定，报价按 k = 0.90 + 0.25·n 浮动（高峰抬价、低谷压价）
  //   - 用电侧：电力按典型日负荷曲线缩放，报价同步按 k = 0.92 + 0.20·n 浮动
  function seedBids(tpl) {
    const bids = [];
    for (let i = 0; i < PERIODS; i++) {
      const n = normalizedLoad(i);
      if (tpl.side === 'gen') {
        // 发电侧：容量固定，报价随系统负荷率上浮 0.90 ~ 1.15
        const k = 0.90 + 0.25 * n;
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
      } else {
        // 用电侧：电力随负荷曲线变化，报价同步浮动 0.92 ~ 1.12
        const f = loadFactor(periodHour(i)) / 0.75;   // 0.75 为典型日最大负荷的标幺参考
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
      participants: TEMPLATE.map(t => ({
        id: t.id, name: t.name, short: t.short, side: t.side, node: t.node,
        color: t.color, enabled: t.enabled,
        bidMode: t.bidMode,
        segments: JSON.parse(JSON.stringify(t.segments || [])),
        quad: t.quad ? JSON.parse(JSON.stringify(t.quad)) : { a: 0, b: 0.3, c: 250, qMax: 300, steps: 120 },
        bids: seedBids(t),
      })),
    };
  }

  /* ------------------------------------------------------- 持久化 */
  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('保存失败', e);
      return false;
    }
  }

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

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- 导入导出 */
  function serialize(state) {
    return JSON.stringify(state, null, 2);
  }

  function deserialize(text) {
    const s = JSON.parse(text);
    if (!s || !Array.isArray(s.participants)) throw new Error('文件格式不正确：缺少 participants');
    if (!s.network || !Array.isArray(s.network.nodes)) throw new Error('文件格式不正确：缺少 network.nodes');
    if (!Array.isArray(s.participants[0].bids)) throw new Error('文件格式不正确：缺少分段报价 bids');
    s.version = VERSION;
    return s;
  }

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

  function exportJSON(state) {
    download('电力现货市场_方案_' + stamp() + '.json', serialize(state), 'application/json;charset=utf-8');
  }

  // 出清结果导出为 CSV（含 BOM，Excel 直接打开不乱码）
  // 列结构：时段 / 时间 / 出清电量 / SMP / 是否阻塞 + 每个节点的 LMP + 每条线路潮流 + 阻塞盈余
  function exportCSV(state, results) {
    const nodes = state.network.nodes;
    const lines = state.network.lines;
    const head = ['时段', '时间', '出清电量(MW)', '系统边际电价(元/MWh)', '是否阻塞'];
    nodes.forEach(n => head.push('LMP_' + n.name + '(元/MWh)'));
    lines.forEach(l => head.push('潮流_' + l.name + '(MW)'));
    head.push('阻塞盈余(元)');

    const rows = [head];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.ok) continue;   // 跳过无成交或无可行解的时段
      const row = [i + 1, periodLabel(i), r.qty.toFixed(2), r.price.toFixed(2), r.congested ? '是' : '否'];
      nodes.forEach(n => row.push((r.lmp[n.id] !== undefined ? r.lmp[n.id] : r.energy).toFixed(2)));
      lines.forEach((l, li) => row.push((r.flows[li] || 0).toFixed(2)));
      row.push(r.rent.toFixed(2));
      rows.push(row);
    }
    // \uFEFF = UTF-8 BOM，避免 Excel 把 UTF-8 CSV 误判为 ANSI 导致中文乱码
    // 字段含逗号 / 引号 / 换行时按 RFC 4180 加双引号并把内部 " 转义为 ""
    const csv = '\uFEFF' + rows.map(r => r.map(c => {
      const s = String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    download('电力现货市场_出清结果_' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
  }

  // 各市场主体 96 时段中标明细导出为 CSV
  // 长表格式：每行 = (时段, 主体, 角色, 节点, 申报量, 中标量, 结算电价, 金额)
  function exportAwardCSV(state, results) {
    const head = ['时段', '时间', '主体', '角色', '节点', '申报量(MW)', '中标量(MW)', '结算电价(元/MWh)', '金额(元)'];
    const rows = [head];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || !r.ok) continue;
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

  // 节点 id → 显示名（北区 / 中区 / 南区）；找不到时回退为 id 本身
  function nodeName(state, id) {
    const n = (state.network.nodes || []).find(x => x.id === id);
    return n ? n.name : id;
  }

  // 文件名时间戳：YYYYMMDD_HHmm
  function stamp() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  root.MarketStore = {
    PERIODS, VERSION, STORAGE_KEY,
    periodHour, periodLabel, loadFactor, normalizedLoad,
    defaultNetwork, TEMPLATE, createDefaultState,
    save, load, clear,
    serialize, deserialize, download,
    exportJSON, exportCSV, exportAwardCSV, nodeName, stamp,
  };

  if (typeof module === 'object' && module.exports) module.exports = root.MarketStore;
})(typeof self !== 'undefined' ? self : this);
