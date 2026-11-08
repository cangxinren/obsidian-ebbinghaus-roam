'use strict';

/*
 * scheduler.js 自测：node test-scheduler.js
 * 覆盖范围过滤、间隔解析、评分推进、初始铺开、到期筛选、日期格式化。
 */

const assert = require('assert');
const Module = require('module');

/* main.js 已是单文件插件，这里 mock obsidian 后取出内置的纯调度逻辑 */
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') {
    return {
      Notice: class {},
      Plugin: class {},
      ItemView: class {},
      PluginSettingTab: class {},
      Modal: class {},
      SuggestModal: class {},
      Setting: class {},
      TFile: class {},
      TFolder: class {},
      Platform: { isMobile: false },
    };
  }
  return originalLoad.apply(this, arguments);
};

const PluginClass = require('./main.js');
const S = PluginClass.__scheduler;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.message ? err.message : err));
  }
}

function baseSettings(over) {
  return Object.assign({}, S.DEFAULT_SETTINGS, over || {});
}

console.log('\n[范围过滤]');
test('默认范围包含普通笔记', () => {
  assert.strictEqual(S.inScope('A-Areas（板块知识点笔记、总结类、本阶段长期有用）/审计.md', baseSettings()), true);
});
test('默认排除 Archives 文件夹', () => {
  assert.strictEqual(S.inScope('Archives（归档，短期无用）/旧.md', baseSettings()), false);
});
test('excludeFolders 不含斜杠时匹配任意层级同名文件夹', () => {
  assert.strictEqual(S.inScope('R-Resources（教材、收藏）/会计/模板/凭证.md', baseSettings()), false);
});
test('excludeFolders 含斜杠时按前缀匹配', () => {
  const s = baseSettings({ excludeFolders: ['R-Resources（教材、收藏）/会计'] });
  assert.strictEqual(S.inScope('R-Resources（教材、收藏）/会计/凭证.md', s), false);
  assert.strictEqual(S.inScope('R-Resources（教材、收藏）/审计/凭证.md', s), true);
});
test('excludeKeywords 命中路径子串', () => {
  const s = baseSettings({ excludeKeywords: ['草稿'] });
  assert.strictEqual(S.inScope('P-Projects/草稿-计划.md', s), false);
});
test('非 markdown 不纳入', () => {
  assert.strictEqual(S.inScope('附件/图.png', baseSettings()), false);
});
test('includeAll=false 时只匹配选中文件夹', () => {
  const s = baseSettings({ includeAll: false, folders: ['A-Areas（板块知识点笔记、总结类、本阶段长期有用）'] });
  assert.strictEqual(S.inScope('A-Areas（板块知识点笔记、总结类、本阶段长期有用）/x/y.md', s), true);
  assert.strictEqual(S.inScope('R-Resources（教材、收藏）/z.md', s), false);
});
test('文件夹前缀不会误匹配同名前缀', () => {
  const s = baseSettings({ includeAll: false, folders: ['A'] });
  assert.strictEqual(S.inScope('AB/note.md', s), false);
  assert.strictEqual(S.inScope('A/note.md', s), true);
});

console.log('\n[间隔解析]');
test('字符串解析并排序去重', () => {
  assert.deepStrictEqual(S.parseIntervals('7, 1, 4，4、2'), [1, 2, 4, 7]);
});
test('非法值被过滤', () => {
  assert.deepStrictEqual(S.parseIntervals('abc, 0, -3, 2.6, 1'), [1, 3]);
});
test('空输入回退默认曲线', () => {
  assert.deepStrictEqual(S.parseIntervals(''), S.DEFAULT_SETTINGS.intervals);
});

console.log('\n[评分推进]');
const intervals = [1, 2, 4, 7];
test('记得晋级并使用新档位间隔', () => {
  const now = 1_000_000_000_000;
  const st = S.makeEnrollment('a.md', now, now);
  const next = S.reviewNote(st, 'remember', intervals, now);
  assert.strictEqual(next.stage, 1);
  assert.strictEqual(next.reviewCount, 1);
  assert.strictEqual(next.nextDue, now + 2 * S.DAY_MS);
});
test('连续记住到顶档后保持', () => {
  const now = 1_000_000_000_000;
  let st = S.makeEnrollment('a.md', now, now);
  for (let i = 0; i < 10; i++) st = S.reviewNote(st, 'remember', intervals, now);
  assert.strictEqual(st.stage, 3);
  assert.strictEqual(st.nextDue, now + 7 * S.DAY_MS);
});
test('模糊保持档位且间隔减半（至少 1 天）', () => {
  const now = 1_000_000_000_000;
  let st = S.makeEnrollment('a.md', now, now);
  st = S.reviewNote(st, 'remember', intervals, now); // stage 1 -> 间隔 2 天
  st = S.reviewNote(st, 'fuzzy', intervals, now);
  assert.strictEqual(st.stage, 1);
  assert.strictEqual(st.nextDue, now + 1 * S.DAY_MS);
});
test('忘记重置到第 0 档', () => {
  const now = 1_000_000_000_000;
  let st = S.makeEnrollment('a.md', now, now);
  st = S.reviewNote(st, 'remember', intervals, now);
  st = S.reviewNote(st, 'remember', intervals, now);
  st = S.reviewNote(st, 'forgot', intervals, now);
  assert.strictEqual(st.stage, 0);
  assert.strictEqual(st.nextDue, now + 1 * S.DAY_MS);
  assert.strictEqual(st.reviewCount, 3);
});
test('不修改传入状态', () => {
  const now = 1_000_000_000_000;
  const st = S.makeEnrollment('a.md', now, now);
  const snapshot = JSON.stringify(st);
  S.reviewNote(st, 'remember', intervals, now);
  assert.strictEqual(JSON.stringify(st), snapshot);
});

console.log('\n[初始铺开]');
test('旧笔记先到期、新笔记后到期', () => {
  const now = 1_700_000_000_000;
  const files = [
    { path: 'new.md', mtime: now - 1 * S.DAY_MS },
    { path: 'old.md', mtime: now - 300 * S.DAY_MS },
    { path: 'mid.md', mtime: now - 30 * S.DAY_MS },
  ];
  const plan = S.buildInitialSchedule(files, now, 30);
  assert.ok(plan['old.md'].nextDue <= plan['mid.md'].nextDue);
  assert.ok(plan['mid.md'].nextDue <= plan['new.md'].nextDue);
});
test('铺开范围不超过 spreadDays + 抖动', () => {
  const now = 1_700_000_000_000;
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `n${i}.md`,
    mtime: now - i * S.DAY_MS,
  }));
  const plan = S.buildInitialSchedule(files, now, 30);
  const dues = Object.values(plan).map((x) => x.nextDue - now);
  assert.ok(Math.min(...dues) >= 0);
  assert.ok(Math.max(...dues) <= 30 * S.DAY_MS + Math.min(S.DAY_MS * 0.5, 6 * 3600 * 1000));
  assert.strictEqual(Object.keys(plan).length, 100);
});
test('单篇笔记今天到期', () => {
  const now = 1_700_000_000_000;
  const plan = S.buildInitialSchedule([{ path: 'only.md', mtime: now }], now, 30);
  assert.ok(plan['only.md'].nextDue - now < 6 * 3600 * 1000);
});
test('按天分桶：第一天就有一批立即到期', () => {
  const now = 1_700_000_000_000;
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `n${i}.md`,
    mtime: now - i * S.DAY_MS,
  }));
  const plan = S.buildInitialSchedule(files, now, 10);
  const immediate = Object.values(plan).filter((x) => x.nextDue === now).length;
  assert.ok(immediate >= 9 && immediate <= 11, `实际立即到期 ${immediate} 篇`);
});

console.log('\n[到期筛选]');
test('只返回已到期并按时间升序', () => {
  const now = 1_700_000_000_000;
  const notes = {
    'a.md': { nextDue: now + S.DAY_MS },
    'b.md': { nextDue: now - 2 * S.DAY_MS },
    'c.md': { nextDue: now - S.DAY_MS },
    'd.md': { nextDue: now },
  };
  const due = S.dueNotes(notes, now);
  assert.deepStrictEqual(due.map((x) => x.path), ['b.md', 'c.md', 'd.md']);
});
test('pathFilter 生效', () => {
  const now = 1_700_000_000_000;
  const notes = {
    'a/x.md': { nextDue: now - 1 },
    'b/y.md': { nextDue: now - 1 },
  };
  const due = S.dueNotes(notes, now, (p) => p.startsWith('a/'));
  assert.deepStrictEqual(due.map((x) => x.path), ['a/x.md']);
});
test('无效状态被忽略', () => {
  const now = 1_700_000_000_000;
  assert.deepStrictEqual(S.dueNotes({ 'a.md': {}, 'b.md': null }, now), []);
});

console.log('\n[日期格式化]');
test('逾期与未来显示', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(S.formatDue(now - 2.2 * S.DAY_MS, now), '逾期 2 天');
  assert.strictEqual(S.formatDue(now - 2 * 3600 * 1000, now), '今天到期');
  assert.strictEqual(S.formatDue(now + 1 * S.DAY_MS, now), '明天');
  assert.strictEqual(S.formatDue(now + 3 * S.DAY_MS, now), '3 天后');
  assert.strictEqual(S.formatDue(now + 60 * S.DAY_MS, now), '2 个月后');
});

console.log('\n[辅助函数]');
test('basename / dirname 处理中文路径', () => {
  assert.strictEqual(S.pathBasename('A/审计笔记.md'), '审计笔记');
  assert.strictEqual(S.pathDirname('A/审计笔记.md'), 'A');
  assert.strictEqual(S.pathDirname('单篇.md'), '');
});
test('hash01 稳定且落在 [0,1)', () => {
  const a = S.hash01('同一个路径.md');
  assert.strictEqual(a, S.hash01('同一个路径.md'));
  assert.ok(a >= 0 && a < 1);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
