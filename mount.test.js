/* 用 jsdom 真实挂载整个 App，遍历全部 7 个页面，捕获模板编译/运行期错误
 * 用法：项目根目录运行 `node js/__tests__/mount.test.js`
 * 退出码 0 = 全部通过；非 0 = 至少一个页面渲染失败或存在运行期错误。
 * 注意：本测试依赖 jsdom 与 fs，运行时需先 `npm i jsdom`。 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const html = '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>';
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const doc = window.document;

const errors = [];
window.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
window.onerror = (m, s, l, c, err) => { errors.push('onerror: ' + (err && err.stack || m)); };
const origErr = console.error.bind(console);
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); };

window.eval(fs.readFileSync(path.join(ROOT, 'vendor/vue.global.prod.js'), 'utf8'));
window.echarts = { init: () => ({ setOption() {}, resize() {}, dispose() {} }) };
window.MarketEngine = require(path.join(ROOT, 'js/engine.js'));
window.MarketStore = require(path.join(ROOT, 'js/store.js'));
window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));

const wait = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const txt = () => doc.getElementById('app').textContent;

(async () => {
  await wait(700); // 首次挂载 + 出清
  const navItems = [...doc.querySelectorAll('.nav-item')];
  console.log('导航项数:', navItems.length);
  const sig = {
    '市场总览': '全日出清电价曲线',
    '报价申报': '报价校验通过',
    '供需曲线': '供需阶梯曲线',
    '电价与阻塞': '节点电价 LMP 走势',
    '结算校验': '一致性校验清单',
    '网络参数': '电抗',
    '数据管理': '方案存档',
  };
  let ok = navItems.length === 7;
  const pageText = {};
  for (const nav of navItems) {
    const label = nav.textContent.trim();
    click(nav);
    await wait(160);
    const content = txt();
    pageText[label] = content;
    const signature = sig[label];
    const pass = signature ? content.includes(signature) : content.length > 200;
    console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  页面: ' + label + (signature ? '  (期望含「' + signature + '」)' : ''));
    if (!pass) ok = false;
  }
  // 结算页：一致性校验清单内容必须真正渲染（来自 checks 计算）
  const settleOk = (pageText['结算校验'] || '').includes('电量守恒') && (pageText['结算校验'] || '').includes('阻塞盈余非负');
  console.log('  ' + (settleOk ? 'PASS' : 'FAIL') + '  结算页 checks 已渲染（电量守恒 / 阻塞盈余非负）');
  if (!settleOk) ok = false;
  // 网络页：节点发电/用电能力应来自真实报价，而非因 this.period 取值错误而全为 0
  const net = pageText['网络参数'] || '';
  const realCap = /500\.0 MW/.test(net) && /723/.test(net);
  console.log('  ' + (realCap ? 'PASS' : 'FAIL') + '  网络页节点能力来自真实报价（北区发电 500 / 中区用电 723 等）');
  if (!realCap) ok = false;
  // 再点一次“执行全日出清”按钮，确保 run() 在无阻塞/有阻塞切换后也正常
  const runBtns = [...doc.querySelectorAll('button')].filter(b => /出清/.test(b.textContent));
  if (runBtns.length) { click(runBtns[0]); await wait(300); console.log('  重新出清按钮: 已触发'); }

  if (errors.length) {
    console.log('\n运行期错误 ' + errors.length + ' 条:');
    errors.forEach(e => console.log('  - ' + e));
    ok = false;
  } else console.log('\n运行期错误: 0');

  console.log('\n===== ' + (ok ? 'ALL PAGES OK' : 'FAILED') + ' =====');
  process.exit(ok ? 0 : 1);
})();
