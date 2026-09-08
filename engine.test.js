/* 引擎自检：无约束出清 / PTDF / 阻塞 LMP / 收支平衡
 * 用法：在项目根目录运行 `node js/__tests__/engine.test.js`（或实际测试路径）
 * 返回 0 表示全部通过，1 表示存在失败用例。 */
const E = require('../js/engine.js');

let pass = 0, fail = 0;
function eq(name, got, want, tol) {
  const t = tol === undefined ? 1e-6 : tol;
  const ok = Math.abs(got - want) <= t;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}: got ${got}, want ${want}`);
  ok ? pass++ : fail++;
}
function ok(name, cond, extra) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ' -> ' + extra : ''}`);
  cond ? pass++ : fail++;
}

/* ============ 用例 1：Qt 桌面版示例数据（手工核算应为 470 MW / 260 元） ============ */
console.log('\n[1] 无约束出清 —— Qt 版示例数据');
const gens = [
  { id: 'g1', name: '东南电厂#1', side: 'gen', node: 'A', bidMode: 'step', segments: [{ power: 100, price: 200 }, { power: 100, price: 260 }, { power: 100, price: 330 }] },
  { id: 'g2', name: '东南电厂#2', side: 'gen', node: 'A', bidMode: 'step', segments: [{ power: 80, price: 220 }, { power: 80, price: 280 }, { power: 80, price: 350 }] },
  { id: 'g3', name: '金陵电厂#1', side: 'gen', node: 'B', bidMode: 'step', segments: [{ power: 120, price: 180 }, { power: 120, price: 250 }, { power: 120, price: 320 }] },
];
const cons = [
  { id: 'c1', name: '工业用户A', side: 'con', node: 'B', segments: [{ power: 150, price: 400 }, { power: 100, price: 300 }, { power: 50, price: 200 }] },
  { id: 'c2', name: '商业用户B', side: 'con', node: 'B', segments: [{ power: 100, price: 350 }, { power: 80, price: 250 }] },
  { id: 'c3', name: '居民用户C', side: 'con', node: 'B', segments: [{ power: 120, price: 380 }, { power: 100, price: 220 }] },
];
const flatNet = { nodes: [{ id: 'A' }, { id: 'B' }], lines: [], slackId: 'A', enabled: false };
const r1 = E.runPeriod([...gens, ...cons], flatNet);
eq('出清电量 (MW)', r1.qty, 470);
eq('统一出清电价 (元/MWh)', r1.price, 260);
eq('发电侧总收入 = 用电侧总支出', Math.abs(r1.totalGenIncome - r1.totalConPayment), 0, 0.01);
eq('总收入 (元)', r1.totalGenIncome, 470 * 260);
ok('供需曲线非空', r1.supplyCurve.length > 0 && r1.demandCurve.length > 0);

/* ============ 用例 2：PTDF 直流潮流 ============ */
console.log('\n[2] 三节点网络 PTDF（平衡节点 A）');
const net3 = {
  nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
  lines: [
    { id: 'L1', from: 'A', to: 'B', x: 0.1, cap: 150 },
    { id: 'L2', from: 'B', to: 'C', x: 0.1, cap: 400 },
    { id: 'L3', from: 'A', to: 'C', x: 0.2, cap: 400 },
  ],
  slackId: 'A', enabled: true,
};
const ptdf = E.computePTDF(net3.nodes, net3.lines, 'A');
eq('PTDF[L1][A]', ptdf.ptdf[0][0], 0, 1e-9);
eq('PTDF[L1][B]', ptdf.ptdf[0][1], -0.75, 1e-9);
eq('PTDF[L1][C]', ptdf.ptdf[0][2], -0.5, 1e-9);

/* ============ 用例 3：阻塞场景 LMP 分解 ============ */
console.log('\n[3] 阻塞再调度与节点电价');
// A 区有廉价电源但外送通道 L1 受限；B、C 为受端
const parts = [
  { id: 'G1', name: '北区廉价机组', side: 'gen', node: 'A', bidMode: 'step', segments: [{ power: 400, price: 100 }] },
  { id: 'G2', name: '中区机组', side: 'gen', node: 'B', bidMode: 'step', segments: [{ power: 300, price: 200 }] },
  { id: 'G3', name: '南区机组', side: 'gen', node: 'C', bidMode: 'step', segments: [{ power: 300, price: 350 }] },
  { id: 'L_B', name: '中区负荷', side: 'con', node: 'B', segments: [{ power: 200, price: 480 }] },
  { id: 'L_C', name: '南区负荷', side: 'con', node: 'C', segments: [{ power: 300, price: 500 }] },
];
const r3 = E.runPeriod(parts, net3);
ok('检测到阻塞', r3.congested === true);
eq('无约束时系统边际电价（再调度前）', r3.price, 200);
eq('能量分量 λ', r3.energy, 100, 0.01);
eq('L1 影子价格 μ', r3.mu[0], 400 / 3, 0.05);
eq('LMP 北区 A（送端）', r3.lmp.A, 100, 0.05);
eq('LMP 中区 B（受端）', r3.lmp.B, 200, 0.05);
eq('LMP 南区 C（受端）', r3.lmp.C, 100 + 400 / 3 * 0.5, 0.05);
eq('L1 潮流已回落到限值 150', r3.flows[0], 150, 0.05);
eq('阻塞盈余 (元)', r3.rent, 20000, 1);
ok('阻塞盈余非负', r3.rent >= -0.01, `rent=${r3.rent}`);
ok('发电侧中标总量守恒', Math.abs(Object.values(r3.genAward).reduce((a, b) => a + b, 0) - r3.qty) < 1e-6);

/* 无阻塞对照：把 L1 容量放大，应回到统一电价 */
const net3Wide = JSON.parse(JSON.stringify(net3));
net3Wide.lines[0].cap = 9999;
const r3w = E.runPeriod(parts, net3Wide);
console.log('\n[4] 放宽线路容量后的对照组');
ok('无阻塞', r3w.congested === false);
eq('统一出清电价', r3w.energy, 200, 0.01);
eq('阻塞盈余应为 0', r3w.rent, 0, 0.05);
eq('A/B/C 电价一致', r3w.lmp.A, r3w.lmp.B, 1e-6);

/* ============ 用例 5：二次曲线报价 ============ */
console.log('\n[5] 二次曲线报价 C(Q) = 0.0005Q² + 0.2Q + 150');
const quadParts = [
  { id: 'GQ', name: '二次曲线机组', side: 'gen', node: 'A', bidMode: 'quadratic', quad: { a: 0.0005, b: 0.2, c: 150, qMax: 400, steps: 400 } },
  { id: 'GF', name: '固定价机组', side: 'gen', node: 'B', bidMode: 'step', segments: [{ power: 500, price: 300 }] },
  { id: 'LD', name: '刚性负荷', side: 'con', node: 'B', segments: [{ power: 300, price: 600 }] },
];
const r5 = E.runPeriod(quadParts, { nodes: [{ id: 'A' }, { id: 'B' }], lines: [], slackId: 'A', enabled: false });
// 300MW 负荷全部由曲线机组承担，其边际价格 = C(300) = 0.0005*90000 + 0.2*300 + 150 = 45+60+150 = 255
eq('曲线机组承担全部负荷', r5.genDetail.find(d => d.id === 'GQ').awarded, 300, 0.5);
eq('出清电价 ≈ C(300) = 255', r5.price, 255, 2);

/* ============ 用例 6：报价校验 ============ */
console.log('\n[6] 报价合法性校验');
ok('发电侧非递减报价通过', E.validateBid(gens[0]).length === 0);
ok('发电侧报价下跌被拦截', E.validateBid({ side: 'gen', segments: [{ power: 100, price: 300 }, { power: 100, price: 200 }] }).length > 0);
ok('用电侧报价上升被拦截', E.validateBid({ side: 'con', segments: [{ power: 100, price: 200 }, { power: 100, price: 300 }] }).length > 0);
ok('电力非正被拦截', E.validateBid({ side: 'gen', segments: [{ power: 0, price: 300 }] }).length > 0);
ok('二次曲线缺 qMax 被拦截', E.validateBid({ side: 'gen', bidMode: 'quadratic', quad: { a: 1, b: 1, c: 1 } }).length > 0);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
