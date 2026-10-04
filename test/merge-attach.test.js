'use strict';

// 三方合并「同编号新增异值主体 — 依附项」耦合的回归测试。
// 两组从同一基线各自新增同编号不同灯具/回路时，引用该编号的新增 Cue/接线
// 不得列为自动项：预览须显示它与冲突主体的关系；保留草稿主体时不得误合入，
// 采用待合入主体时正确带入；依附项自身另有冲突须逐项抉择；不一致的抉择、
// 最终重名/引用缺失整次拒绝；无依附冲突的单侧改动仍自动合入。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Merge = require('../src/merge.js');

function baseSnapshot() {
  return {
    lights: [
      { id: 1, name: '面光1' },
      { id: 2, name: '侧光L' },
    ],
    circuits: [{ id: 1, name: '面光回路', capacity: 1500 }],
    cues: [
      { cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 },
      { cue_no: 2, light_id: 2, time: 2, target: 80, duration: 1 },
    ],
    wiring: [
      { light_id: 1, circuit_id: 1, watts: 300 },
      { light_id: 2, circuit_id: null, watts: null },
    ],
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
const findConflict = (cls, key) => cls.conflicts.find((c) => c.key === key) || null;

// 两侧从基线各自新增同编号灯 9（不同灯具），待合入侧另新增引用灯 9 的 Cue 5
function divergentLightWithCue() {
  const base = baseSnapshot();
  const draft = clone(base);
  draft.lights.push({ id: 9, name: '草稿新灯' });
  draft.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  const incoming = clone(base);
  incoming.lights.push({ id: 9, name: '对方新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 5, light_id: 9, time: 3, target: 70, duration: 2 });
  return { base, draft, incoming };
}

test('同编号新增异值灯：引用它的待合入新增 Cue 不是自动项，列为依附冲突并显示关系', () => {
  const { base, draft, incoming } = divergentLightWithCue();
  const cls = Merge.classify(base, draft, incoming);

  assert.equal(findConflict(cls, 'light:9')?.reason, 'same_key_diff');
  const cue5 = findConflict(cls, 'cue:5');
  assert.ok(cue5, 'cue:5 必须列为冲突而非自动项');
  assert.equal(cls.auto.some((a) => a.key === 'cue:5'), false);
  assert.equal(cue5.reason, 'attached_to_conflict');
  assert.deepEqual(cue5.attached, [
    { host_kind: 'light', host_id: 9, host_key: 'light:9', sides: ['incoming'] },
  ]);
  // 依附项自身无冲突（非结构性），可跟随主体
  assert.notEqual(cue5.status, 'conflict');
});

test('保留草稿主体：依附 Cue 不引入（不会挂到草稿侧同编号灯上）', () => {
  const { base, draft, incoming } = divergentLightWithCue();
  const r = Merge.resolve(base, draft, incoming, { 'light:9': 'draft' });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.final.lights.find((l) => l.id === 9).name, '草稿新灯');
  assert.equal(r.final.cues.some((c) => c.cue_no === 5), false);
});

test('采用待合入主体：依附 Cue 正确合入并引用该侧灯具', () => {
  const { base, draft, incoming } = divergentLightWithCue();
  const r = Merge.resolve(base, draft, incoming, { 'light:9': 'incoming' });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.final.lights.find((l) => l.id === 9).name, '对方新灯');
  const cue5 = r.final.cues.find((c) => c.cue_no === 5);
  assert.ok(cue5);
  assert.equal(cue5.light_id, 9);
  assert.equal(cue5.target, 70);
});

test('主体保留草稿却强行合入对方 Cue → 整次拒绝（依附不一致）且结果不变', () => {
  const { base, draft, incoming } = divergentLightWithCue();
  const r = Merge.resolve(base, draft, incoming, {
    'light:9': 'draft',
    'cue:5': 'incoming',
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.key === 'cue:5' && v.code === 'attachment_mismatch'));
});

test('主体未抉择时依附项不自动落定，计入未决', () => {
  const { base, draft, incoming } = divergentLightWithCue();
  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, false);
  assert.ok(r.unresolved.includes('light:9'));
});

test('同编号新增异值回路：指向它的待合入接线不是自动 update，跟随主体', () => {
  const base = baseSnapshot(); // 灯1 已接回路1
  const draft = clone(base);
  draft.circuits.push({ id: 7, name: '草稿回路', capacity: 2000 });
  const incoming = clone(base);
  incoming.circuits.push({ id: 7, name: '对方回路', capacity: 3000 });
  incoming.wiring[0] = { light_id: 1, circuit_id: 7, watts: 500 };

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findConflict(cls, 'circuit:7')?.reason, 'same_key_diff');
  const w1 = findConflict(cls, 'wiring:1');
  assert.ok(w1, 'wiring:1 必须列为依附冲突');
  assert.equal(cls.auto.some((a) => a.key === 'wiring:1'), false);
  assert.deepEqual(w1.attached[0], {
    host_kind: 'circuit',
    host_id: 7,
    host_key: 'circuit:7',
    sides: ['incoming'],
  });

  // 保留草稿回路 7：灯 1 接线保持基线（回路1），不挂到草稿回路 7
  const rd = Merge.resolve(base, draft, incoming, { 'circuit:7': 'draft' });
  assert.equal(rd.ok, true, JSON.stringify(rd.violations));
  assert.equal(rd.final.wiring.find((w) => w.light_id === 1).circuit_id, 1);

  // 采用待合入回路 7：接线跟随改投回路 7
  const ri = Merge.resolve(base, draft, incoming, { 'circuit:7': 'incoming' });
  assert.equal(ri.ok, true, JSON.stringify(ri.violations));
  const w = ri.final.wiring.find((x) => x.light_id === 1);
  assert.equal(w.circuit_id, 7);
  assert.equal(w.watts, 500);

  // 主体选草稿、接线强选待合入 → 拒绝
  const bad = Merge.resolve(base, draft, incoming, {
    'circuit:7': 'draft',
    'wiring:1': 'incoming',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.code === 'attachment_mismatch'));
});

test('同编号新增异值灯且两侧都把它接到不同回路：接线自身是冲突，须逐项抉择', () => {
  const base = {
    lights: [],
    circuits: [
      { id: 1, name: 'C1', capacity: 1000 },
      { id: 2, name: 'C2', capacity: 800 },
    ],
    cues: [],
    wiring: [],
  };
  const draft = {
    lights: [{ id: 3, name: 'D灯' }],
    circuits: clone(base.circuits),
    cues: [],
    wiring: [{ light_id: 3, circuit_id: 2, watts: 50 }],
  };
  const incoming = {
    lights: [{ id: 3, name: 'I灯' }],
    circuits: clone(base.circuits),
    cues: [],
    wiring: [{ light_id: 3, circuit_id: 1, watts: 99 }],
  };
  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findConflict(cls, 'light:3')?.reason, 'same_key_diff');
  const w3 = findConflict(cls, 'wiring:3');
  assert.equal(w3.reason, 'same_key_diff'); // 两侧真实接线不同 → 自身结构性冲突
  assert.equal(w3.attached[0].host_key, 'light:3');
  assert.deepEqual(w3.attached[0].sides, ['draft', 'incoming']);

  // 只选灯不选接线 → 接线未决（自身有冲突，不自动跟随）
  const r0 = Merge.resolve(base, draft, incoming, { 'light:3': 'incoming' });
  assert.equal(r0.ok, false);
  assert.ok(r0.unresolved.includes('wiring:3'));

  // 同侧抉择（draft/draft）→ 草稿接线
  const rd = Merge.resolve(base, draft, incoming, {
    'light:3': 'draft',
    'wiring:3': 'draft',
  });
  assert.equal(rd.ok, true);
  assert.deepEqual(rd.final.wiring.find((w) => w.light_id === 3), {
    light_id: 3,
    circuit_id: 2,
    watts: 50,
  });

  // 同侧抉择（incoming/incoming）→ 待合入接线带入
  const ri = Merge.resolve(base, draft, incoming, {
    'light:3': 'incoming',
    'wiring:3': 'incoming',
  });
  assert.equal(ri.ok, true);
  assert.deepEqual(ri.final.wiring.find((w) => w.light_id === 3), {
    light_id: 3,
    circuit_id: 1,
    watts: 99,
  });

  // 交叉抉择（任一方向）→ 依附不一致，整次拒绝
  for (const resolutions of [
    { 'light:3': 'incoming', 'wiring:3': 'draft' },
    { 'light:3': 'draft', 'wiring:3': 'incoming' },
  ]) {
    const bad = Merge.resolve(base, draft, incoming, resolutions);
    assert.equal(bad.ok, false);
    assert.ok(bad.violations.some((v) => v.key === 'wiring:3' && v.code === 'attachment_mismatch'));
  }
});

test('单侧新增灯只有一侧写了真实接线：跟随该侧，另一侧不凭空补未分配', () => {
  const base = {
    lights: [],
    circuits: [{ id: 1, name: 'C1', capacity: 1000 }],
    cues: [],
    wiring: [],
  };
  const draft = {
    lights: [{ id: 4, name: 'D灯' }],
    circuits: clone(base.circuits),
    cues: [],
    wiring: [], // 草稿侧无真实接线行
  };
  const incoming = {
    lights: [{ id: 4, name: 'I灯' }],
    circuits: clone(base.circuits),
    cues: [],
    wiring: [{ light_id: 4, circuit_id: 1, watts: 99 }],
  };
  const cls = Merge.classify(base, draft, incoming);
  assert.ok(findConflict(cls, 'light:4'));
  assert.ok(findConflict(cls, 'wiring:4'));

  // 选草稿：灯保留、对方真实接线不带入（落库为未分配，而不是挂到任何回路上）
  const rd = Merge.resolve(base, draft, incoming, { 'light:4': 'draft' });
  assert.equal(rd.ok, true);
  assert.deepEqual(rd.final.wiring.find((w) => w.light_id === 4), {
    light_id: 4,
    circuit_id: null,
    watts: null,
  });

  const ri = Merge.resolve(base, draft, incoming, { 'light:4': 'incoming' });
  assert.equal(ri.ok, true);
  assert.deepEqual(ri.final.wiring.find((w) => w.light_id === 4), {
    light_id: 4,
    circuit_id: 1,
    watts: 99,
  });
});

test('重名冲突主体的单侧新增 Cue 同样降级为依附冲突，主体不引入时不悬空', () => {
  const base = baseSnapshot(); // 灯1=面光1
  const draft = clone(base);
  const incoming = clone(base);
  incoming.lights.push({ id: 5, name: '面光1' }); // 与灯1重名
  incoming.wiring.push({ light_id: 5, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 6, light_id: 5, time: 1, target: 60, duration: 0 });

  const cls = Merge.classify(base, draft, incoming);
  assert.ok(cls.auto.every((a) => a.key !== 'cue:6'));
  assert.ok(findConflict(cls, 'cue:6'));

  // 灯 5 不引入；Cue 6 也选草稿侧（不存在）→ 通过且不悬空
  const rd = Merge.resolve(base, draft, incoming, {
    'light:1': 'draft',
    'light:5': 'draft',
    'cue:6': 'draft',
  });
  assert.equal(rd.ok, true);
  assert.equal(rd.final.cues.some((c) => c.cue_no === 6), false);

  // 灯 5 不引入却保留 Cue 6 → 引用缺失，整次拒绝
  const bad = Merge.resolve(base, draft, incoming, {
    'light:1': 'draft',
    'light:5': 'draft',
    'cue:6': 'incoming',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.code === 'reference_missing'));
});

test('无依附冲突的单侧改动仍自动合入', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  // 全新编号、无重名：灯/Cue/接线均单侧新增
  incoming.lights.push({ id: 12, name: '全新灯' });
  incoming.wiring.push({ light_id: 12, circuit_id: 1, watts: 100 });
  incoming.cues.push({ cue_no: 9, light_id: 12, time: 4, target: 20, duration: 1 });
  incoming.cues[0].target = 95; // 既有 Cue 单侧修改

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(cls.summary.conflicts_total, 0);
  const keys = cls.auto.map((a) => `${a.kind}:${a.id}:${a.action}`).sort();
  assert.ok(keys.includes('light:12:add'));
  assert.ok(keys.includes('wiring:12:add'));
  assert.ok(keys.includes('cue:9:add'));
  assert.ok(keys.includes('cue:1:update'));

  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, true);
  assert.equal(r.final.lights.some((l) => l.id === 12), true);
  assert.equal(r.final.cues.find((c) => c.cue_no === 1).target, 95);
  assert.equal(r.final.wiring.find((w) => w.light_id === 12).circuit_id, 1);
});
