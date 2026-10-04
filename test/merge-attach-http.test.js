'use strict';

// 版本合并「同编号新增异值主体 — 依附项」缺陷的端到端回归：
// 预览须把引用冲突编号的新增 Cue/接线列为冲突并显示与主体的关系；
// 保留草稿主体不得误合入对方依附项；采用待合入主体正确带入；
// 不一致抉择整次拒绝且草稿不变；无依附冲突的单侧改动仍自动合入。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-merge-attach-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const DB_PATH = process.env.DB_PATH;
const { app } = require('../server.js');

let server;
let port;
const raw = new Database(DB_PATH);

function httpJson(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p) => httpJson('GET', p);
const post = (p, b) => httpJson('POST', p, b);
const put = (p, b) => httpJson('PUT', p, b);

function hardReset() {
  raw.exec(`
    DELETE FROM record_ops;
    DELETE FROM rehearsal_records;
    DELETE FROM merge_previews;
    DELETE FROM cues;
    DELETE FROM lights;
    DELETE FROM circuits;
    DELETE FROM room_handovers;
    DELETE FROM room_programs;
    DELETE FROM room_stops;
    DELETE FROM room_schedules;
    DELETE FROM rooms;
    DELETE FROM version_cues;
    DELETE FROM version_light_wiring;
    DELETE FROM version_circuits;
    DELETE FROM version_lights;
    DELETE FROM versions;
    DELETE FROM sqlite_sequence;
  `);
}

function insertVersion(label, snap) {
  const info = raw
    .prepare('INSERT INTO versions (label, created_at, cue_count) VALUES (?, ?, ?)')
    .run(label, Date.now() / 1000, snap.cues.length);
  const vid = info.lastInsertRowid;
  snap.lights.forEach((l, i) =>
    raw
      .prepare('INSERT INTO version_lights (version_id, light_id, name, pos) VALUES (?, ?, ?, ?)')
      .run(vid, l.id, l.name, i)
  );
  snap.cues.forEach((c, i) =>
    raw
      .prepare(
        `INSERT INTO version_cues
           (version_id, cue_no, light_id, time, target, duration, pos)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(vid, c.cue_no, c.light_id, c.time, c.target, c.duration, i)
  );
  snap.circuits.forEach((c, i) =>
    raw
      .prepare(
        'INSERT INTO version_circuits (version_id, circuit_id, name, capacity, pos) VALUES (?, ?, ?, ?, ?)'
      )
      .run(vid, c.id, c.name, c.capacity, i)
  );
  for (const w of snap.wiring) {
    raw
      .prepare(
        'INSERT INTO version_light_wiring (version_id, light_id, circuit_id, watts) VALUES (?, ?, ?, ?)'
      )
      .run(vid, w.light_id, w.circuit_id, w.watts);
  }
  return vid;
}

// 当前草稿直接写库（模拟 A 组的工作稿），并发布基线版本 1
function seedDraftAndBase(base) {
  const now = Date.now() / 1000;
  for (const l of base.lights) {
    raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(l.id, l.name, now);
  }
  for (const c of base.circuits) {
    raw
      .prepare('INSERT INTO circuits (id, name, capacity, created_at) VALUES (?, ?, ?, ?)')
      .run(c.id, c.name, c.capacity, now);
  }
  for (const q of base.cues) {
    raw
      .prepare(
        'INSERT INTO cues (cue_no, light_id, time, target, duration) VALUES (?, ?, ?, ?, ?)'
      )
      .run(q.cue_no, q.light_id, q.time, q.target, q.duration);
  }
  for (const w of base.wiring) {
    raw
      .prepare('UPDATE lights SET circuit_id = ?, watts = ? WHERE id = ?')
      .run(w.circuit_id, w.watts, w.light_id);
  }
  return insertVersion('共同基线', base);
}

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

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  raw.close();
});
beforeEach(() => {
  hardReset();
});

test('同编号新增异值灯+对方新增 Cue：预览列为依附冲突，保留草稿主体不误合入', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);

  // 草稿（A 组）：新增灯 9
  raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(
    9,
    '草稿新灯',
    Date.now() / 1000
  );
  // 待合入版本（B 组）：新增另一盏灯 9，并加引用灯 9 的 Cue 5
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 9, name: '对方新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 5, light_id: 9, time: 3, target: 70, duration: 2 });
  const incomingId = insertVersion('B组-新灯Cue', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const light9 = pv.json.conflicts.find((c) => c.key === 'light:9');
  assert.equal(light9.reason, 'same_key_diff');
  const cue5 = pv.json.conflicts.find((c) => c.key === 'cue:5');
  assert.ok(cue5, 'cue:5 必须在冲突列表中，而非自动项');
  assert.equal(pv.json.auto.some((a) => a.key === 'cue:5'), false);
  assert.equal(cue5.reason, 'attached_to_conflict');
  // 页面/API 呈现依附关系
  assert.equal(cue5.attached[0].host_key, 'light:9');
  assert.deepEqual(cue5.attached[0].sides, ['incoming']);
  // 各侧选项下显示选择后的结果
  const incomingWarn = cue5.reasons.find((r) => r.side === 'incoming');
  const draftWarn = cue5.reasons.find((r) => r.side === 'draft');
  assert.match(incomingWarn.text, /合入/);
  assert.match(draftWarn.text, /不引入/);

  // 保留草稿灯 9（依附项不逐项指定，服务端自动跟随）→ 提交成功
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:9': 'draft' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l]));
  assert.equal(byId[9].name, '草稿新灯');
  const cues = (await get('/api/cues')).json;
  assert.equal(cues.some((c) => c.cue_no === 5), false); // 对方 Cue 未误挂到草稿灯 9

  // 已发布版本不变
  const vIncoming = (await get(`/api/versions/${incomingId}`)).json;
  assert.equal(vIncoming.lights.find((l) => l.id === 9).name, '对方新灯');
});

test('同一场景采用待合入主体：对方 Cue 与接线正确合入', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);
  raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(
    9,
    '草稿新灯',
    Date.now() / 1000
  );
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 9, name: '对方新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: 1, watts: 333 });
  incoming.cues.push({ cue_no: 5, light_id: 9, time: 3, target: 70, duration: 2 });
  const incomingId = insertVersion('B组-新灯Cue', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:9': 'incoming' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l]));
  assert.equal(byId[9].name, '对方新灯');
  assert.equal(byId[9].circuit_id, 1);
  assert.equal(byId[9].watts, 333);
  const cue5 = (await get('/api/cues')).json.find((c) => c.cue_no === 5);
  assert.ok(cue5);
  assert.equal(cue5.light_id, 9);
  assert.equal(cue5.target, 70);
});

test('主体保留草稿却强行合入对方 Cue → 400 整次拒绝且草稿不变', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);
  raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(
    9,
    '草稿新灯',
    Date.now() / 1000
  );
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 9, name: '对方新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 5, light_id: 9, time: 3, target: 70, duration: 2 });
  const incomingId = insertVersion('B组-新灯Cue', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  const bad = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:9': 'draft', 'cue:5': 'incoming' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.violations.some((v) => v.code === 'attachment_mismatch'));

  // 草稿不变
  const lights = (await get('/api/lights')).json;
  assert.equal(lights.find((l) => l.id === 9).name, '草稿新灯');
  assert.equal((await get('/api/cues')).json.some((c) => c.cue_no === 5), false);

  // 令牌仍可用于更正后的提交
  const ok = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:9': 'incoming', 'cue:5': 'incoming' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await get('/api/cues')).json.find((c) => c.cue_no === 5).light_id, 9);
});

test('同编号新增异值回路+对方接线改投：保留草稿回路时接线不挂错', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);
  // 草稿新增回路 7
  raw
    .prepare('INSERT INTO circuits (id, name, capacity, created_at) VALUES (?, ?, ?, ?)')
    .run(7, '草稿回路', 2000, Date.now() / 1000);
  // 待合入新增另一回路 7，并把灯 1 接线改投回路 7
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.circuits.push({ id: 7, name: '对方回路', capacity: 3000 });
  incoming.wiring[0] = { light_id: 1, circuit_id: 7, watts: 500 };
  const incomingId = insertVersion('B组-并回路', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.ok(pv.json.conflicts.find((c) => c.key === 'circuit:7'));
  const w1 = pv.json.conflicts.find((c) => c.key === 'wiring:1');
  assert.ok(w1, 'wiring:1 必须列为依附冲突而非自动 update');
  assert.equal(pv.json.auto.some((a) => a.key === 'wiring:1'), false);

  // 保留草稿回路 7 → 灯 1 接线保持回路 1
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'circuit:7': 'draft' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const lights = (await get('/api/lights')).json;
  assert.equal(lights.find((l) => l.id === 1).circuit_id, 1);
  const circuits = (await get('/api/circuits')).json;
  assert.equal(circuits.find((c) => c.id === 7).name, '草稿回路');

  // 已发布版本与调光记录不受影响：快照仍是对方回路 7、灯1投7
  const v = (await get(`/api/versions/${incomingId}`)).json;
  assert.equal(v.circuits.find((c) => c.id === 7).name, '对方回路');
});

test('预览后草稿变化 → 409；成功提交为一次事务（无部分写入）', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 9, name: '对方新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 5, light_id: 9, time: 3, target: 70, duration: 2 });
  const incomingId = insertVersion('B组-新灯Cue', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  // 预览后改草稿
  const added = await post('/api/lights', { name: '预览后改动' });
  assert.equal(added.status, 201);
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:9': 'incoming' },
  });
  assert.equal(cm.status, 409);
  // 草稿仅多出预览后那盏灯，合入未部分写入
  const lights = (await get('/api/lights')).json;
  assert.equal(lights.some((l) => l.id === 9), false);
  assert.ok(lights.some((l) => l.name === '预览后改动'));
});

test('无依附冲突的单侧新增仍自动合入（全新编号灯+Cue+接线）', async () => {
  const base = baseSnapshot();
  seedDraftAndBase(base);
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 12, name: '对方全新灯' });
  incoming.wiring.push({ light_id: 12, circuit_id: 1, watts: 100 });
  incoming.cues.push({ cue_no: 8, light_id: 12, time: 4, target: 20, duration: 1 });
  const incomingId = insertVersion('B组-全新灯', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.json.summary.conflicts_total, 0);
  const keys = pv.json.auto.map((a) => `${a.kind}:${a.id}:${a.action}`);
  assert.ok(keys.includes('light:12:add'));
  assert.ok(keys.includes('cue:8:add'));
  assert.ok(keys.includes('wiring:12:add'));

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const l12 = (await get('/api/lights')).json.find((l) => l.id === 12);
  assert.equal(l12.name, '对方全新灯');
  assert.equal(l12.circuit_id, 1);
  assert.equal((await get('/api/cues')).json.find((c) => c.cue_no === 8).light_id, 12);
});
