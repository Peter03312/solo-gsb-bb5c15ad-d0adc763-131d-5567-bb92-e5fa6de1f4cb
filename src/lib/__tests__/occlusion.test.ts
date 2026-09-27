import { describe, expect, it } from 'vitest';
import {
  blockingOcclusions,
  describeOcclusion,
  overlaps,
  parseOcclusions,
  parseSide,
  planOcclusionTracks,
  serializeTrackCsv,
  TRACK_LABEL,
} from '../occlusion';

function cue(start: number, end: number, text = 'X') {
  return { start, end, text };
}

const fmt = (ms: number) => `t${ms}`;
const tracks = (text: string) => parseOcclusions(text).occlusions;

describe('parseSide 位置词归一化', () => {
  it('识别上/下及常见同义词', () => {
    expect(parseSide('上')).toBe('top');
    expect(parseSide(' 上方 ')).toBe('top');
    expect(parseSide('上轨')).toBe('top');
    expect(parseSide('TOP')).toBe('top');
    expect(parseSide('up')).toBe('top');
    expect(parseSide('下')).toBe('bottom');
    expect(parseSide('下方')).toBe('bottom');
    expect(parseSide('下轨')).toBe('bottom');
    expect(parseSide('Bottom')).toBe('bottom');
    expect(parseSide('down')).toBe('bottom');
  });

  it('无法识别返回 null', () => {
    expect(parseSide('中')).toBeNull();
    expect(parseSide('')).toBeNull();
  });
});

describe('parseOcclusions 遮挡列表解析', () => {
  it('每行三列，保持填写顺序，物理行号即报错行号', () => {
    const r = parseOcclusions('5000 12000 上\n\n20000，26500，下\n  0 \t 1000 \t top\n');
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(3);
    expect(r.occlusions.map((o) => [o.start, o.end, o.side])).toEqual([
      [5000, 12000, 'top'],
      [20000, 26500, 'bottom'],
      [0, 1000, 'top'],
    ]);
    expect(r.occlusions.map((o) => o.line)).toEqual([1, 3, 4]);
  });

  it('允许重复、重叠、倒序，不排序不去重', () => {
    const r = parseOcclusions('9000 10000 上\n1000 2000 下\n9000 10000 上\n5000 6000 下');
    expect(r.invalid).toEqual([]);
    expect(r.occlusions.map((o) => o.start)).toEqual([9000, 1000, 9000, 5000]);
  });

  it('格式错误逐行标出原因', () => {
    const text = [
      '1000 2000 上',
      'abc 2000 上',
      '3000 下',
      '1000 500 600 下',
      '-100 200 上',
      '3000 3000 下',
      '4000 3000 上',
      '1000 2000 中',
      '1.5 2.5 上',
    ].join('\n');
    const r = parseOcclusions(text);
    expect(r.occlusions).toHaveLength(1);
    expect(r.invalid.map((b) => b.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.totalLines).toBe(9);
    expect(r.invalid.find((b) => b.line === 8)!.reason).toContain('位置');
    expect(r.invalid.find((b) => b.line === 6)!.reason).toContain('小于');
    expect(r.invalid.find((b) => b.line === 3)!.reason).toContain('三个字段');
  });

  it('空文本', () => {
    const r = parseOcclusions('');
    expect(r.occlusions).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(0);
  });
});

describe('overlaps 半开区间重叠', () => {
  it('正时长重叠才算，相切不算', () => {
    expect(overlaps(0, 1000, 500, 1500)).toBe(true);
    expect(overlaps(0, 1000, 1000, 2000)).toBe(false);
    expect(overlaps(1000, 2000, 0, 1000)).toBe(false);
    expect(overlaps(0, 1000, 2000, 3000)).toBe(false);
    expect(overlaps(0, 1000, 0, 1000)).toBe(true);
  });

  it('blockingOcclusions 只取同位置且重叠的行，按录入顺序', () => {
    const oc = tracks('0 5000 上\n4000 6000 下\n4500 4800 上');
    // cue [4000,5000)：上轨与行 1 [0,5000)、行 3 [4500,4800) 正时长重叠
    expect(blockingOcclusions(4000, 5000, 'top', oc).map((o) => o.line)).toEqual([1, 3]);
    // 下轨行 2 [4000,6000) 包含字幕起点 → 正时长重叠，命中
    expect(blockingOcclusions(4000, 5000, 'bottom', oc).map((o) => o.line)).toEqual([2]);
    // 相切不挡：遮挡在字幕结束点才开始，或在字幕开始点已结束
    const tangent = tracks('5000 6000 下\n0 4000 下');
    expect(blockingOcclusions(4000, 5000, 'bottom', tangent)).toEqual([]);
  });
});

describe('planOcclusionTracks 轨道优化', () => {
  it('无遮挡时全部下轨（默认下轨），零切换、零上轨', () => {
    const plan = planOcclusionTracks([cue(0, 1000), cue(2000, 3000)], []);
    expect(plan.ok).toBe(true);
    expect(plan.items.map((i) => i.track)).toEqual(['bottom', 'bottom']);
    expect(plan.switches).toBe(0);
    expect(plan.topCount).toBe(0);
  });

  it('下轨被挡的唯一条目改到上轨；相邻空闲条若贴着它更省切换则一起在上轨', () => {
    // 2 条、第 1 条下轨被挡（T.）：TB=1 切换 1 上轨，TT=0 切换 2 上轨 → 取 TT
    const plan = planOcclusionTracks([cue(0, 1000), cue(2000, 3000)], tracks('500 1500 下'));
    expect(plan.ok).toBe(true);
    expect(plan.items.map((i) => i.track)).toEqual(['top', 'top']);
    expect(plan.switches).toBe(0);
    expect(plan.topCount).toBe(2);

    // 3 条、仅中间条下轨被挡（.T.）：BTB=2 切换 1 上轨；TTT=0 切换 3 上轨 → 取 TTT
    const plan2 = planOcclusionTracks(
      [cue(0, 1000), cue(2000, 3000), cue(4000, 5000)],
      tracks('2500 2600 下'),
    );
    expect(plan2.items.map((i) => i.track)).toEqual(['top', 'top', 'top']);
    expect(plan2.switches).toBe(0);

    // 仅存在单侧强制时，全程同轨为 0 切换，故单条上挡会让整条序列走上轨；
    // 只有两侧都有强制条时切换才不可避免。构造 T..B：首条强制上、末条强制下
    const plan3 = planOcclusionTracks(
      [cue(0, 1000), cue(1000, 2000), cue(2000, 3000), cue(3000, 4000)],
      tracks('0 1000 下\n3000 4000 上'),
    );
    // TTTB = 1 切换 3 上轨；TBBB = 1 切换 1 上轨 → 切换并列，上轨更少的 TBBB 胜
    expect(plan3.items.map((i) => i.track)).toEqual(['top', 'bottom', 'bottom', 'bottom']);
    expect(plan3.switches).toBe(1);
    expect(plan3.topCount).toBe(1);
  });

  it('第一目标是最小化切换：连续下挡区连同相邻空闲条整体留在上轨', () => {
    // 第 2、3 条下轨被挡（.TT.），第 1、4 条两轨空闲：
    // BTTB = 2 次切换、2 条上轨；TTTT = 0 次切换、4 条上轨 → 切换优先，取 TTTT
    const plan = planOcclusionTracks(
      [cue(0, 1000), cue(2000, 2500), cue(3000, 3500), cue(5000, 6000)],
      tracks('1500 4500 下'),
    );
    expect(plan.ok).toBe(true);
    expect(plan.items.map((i) => i.track)).toEqual(['top', 'top', 'top', 'top']);
    expect(plan.switches).toBe(0);
    expect(plan.topCount).toBe(4);
  });

  it('切换数并列时最小化上轨条数：切换点放在约束边界、空闲条尽量下轨', () => {
    // 第 1 条仅上轨可用（下挡），第 3 条仅下轨可用（上挡），第 2 条空闲（T.B）：
    // TTB = 1 次切换、2 条上轨；TBB = 1 次切换、1 条上轨 → 取 TBB
    const plan = planOcclusionTracks(
      [cue(0, 1000), cue(1000, 2000), cue(2000, 3000)],
      tracks('0 1000 下\n2000 3000 上'),
    );
    expect(plan.ok).toBe(true);
    expect(plan.items.map((i) => i.track)).toEqual(['top', 'bottom', 'bottom']);
    expect(plan.switches).toBe(1);
    expect(plan.topCount).toBe(1);
  });

  it('上轨全程被挡时所有条目走下轨，零切换', () => {
    const plan = planOcclusionTracks(
      [cue(0, 1000), cue(2000, 3000), cue(4000, 5000)],
      tracks('0 5000 上'),
    );
    expect(plan.ok).toBe(true);
    expect(plan.items.every((i) => i.track === 'bottom')).toBe(true);
    expect(plan.switches).toBe(0);
    expect(plan.topCount).toBe(0);
  });

  it('某条两轨均被遮挡时无方案：报首条原因，且不导出部分方案', () => {
    const plan = planOcclusionTracks(
      [cue(0, 1000), cue(2000, 3000), cue(3500, 3800), cue(5000, 6000)],
      tracks('0 10000 上\n3000 4000 下'),
    );
    expect(plan.ok).toBe(false);
    expect(plan.blockedIndex).toBe(3);
    expect(plan.reason).toContain('第 3 条');
    expect(plan.reason).toContain('上轨');
    expect(plan.reason).toContain('下轨');
    // 不导出部分方案
    expect(plan.items).toEqual([]);
    expect(plan.switches).toBe(0);
    expect(plan.topCount).toBe(0);
  });

  it('无解原因引用两轨各自首条命中遮挡的行号', () => {
    const oc = tracks('100 200 上\n100 200 下');
    const plan = planOcclusionTracks([cue(0, 1000)], oc);
    expect(plan.ok).toBe(false);
    expect(describeOcclusion(oc[0])).toContain('第 1 行');
    expect(plan.reason).toContain('第 1 行');
    expect(plan.reason).toContain('第 2 行');
  });

  it('更早出现的两轨皆挡字幕优先报出', () => {
    const plan = planOcclusionTracks(
      [cue(0, 100), cue(200, 300), cue(400, 500)],
      tracks('0 1000 上\n0 150 下\n250 280 下'),
    );
    expect(plan.ok).toBe(false);
    expect(plan.blockedIndex).toBe(1);
  });

  it('相切不构成遮挡，方案仍全部下轨', () => {
    // 字幕 [1000,2000)，遮挡 [0,1000) 与 [2000,3000) 均仅端点接触
    const plan = planOcclusionTracks([cue(1000, 2000)], tracks('0 1000 下\n2000 3000 下'));
    expect(plan.ok).toBe(true);
    expect(plan.items[0].track).toBe('bottom');
  });

  it('items 带回每条字幕两轨的遮挡依据', () => {
    const plan = planOcclusionTracks(
      [cue(0, 1000), cue(2000, 3000)],
      tracks('0 5000 上\n1200 1500 下'),
    );
    expect(plan.ok).toBe(true);
    // 第 1 条上轨被挡 → 下轨；第 2 条上轨被挡、下轨空闲 → 下轨
    expect(plan.items[0].track).toBe('bottom');
    expect(plan.items[0].topBlocked.map((o) => o.line)).toEqual([1]);
    expect(plan.items[0].bottomBlocked).toEqual([]);
    expect(plan.items[1].track).toBe('bottom');
    expect(plan.items[1].topBlocked.map((o) => o.line)).toEqual([1]);
  });

  it('同位置重叠的遮挡行各自参与判定（行 1、3 同时命中）', () => {
    const plan = planOcclusionTracks(
      [cue(100, 200)],
      tracks('0 500 下\n0 500 上\n150 180 下'),
    );
    // 上轨被第 2 行挡、下轨被第 1、3 行挡 → 无解
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('第 2 行');
  });

  it('空字幕列表给出空方案', () => {
    const plan = planOcclusionTracks([], tracks('0 1000 上'));
    expect(plan).toMatchObject({ ok: true, items: [], switches: 0, topCount: 0 });
  });
});

describe('serializeTrackCsv CSV 导出', () => {
  it('含序号、起止时间与轨道，字段加引号、CRLF 换行，不含文本与 SRT', () => {
    // 4 条：首条仅上轨可用、末条仅下轨可用，最优 = 上 下 下 下（1 次切换、1 条上轨）
    const plan = planOcclusionTracks(
      [cue(0, 1000, 'A'), cue(1000, 2000, 'B'), cue(2000, 3000, 'C'), cue(3000, 4000, 'D')],
      tracks('0 1000 下\n3000 4000 上'),
    );
    expect(plan.items.map((i) => i.track)).toEqual(['top', 'bottom', 'bottom', 'bottom']);
    const csv = serializeTrackCsv(plan.items, fmt);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('"序号","开始时间","结束时间","轨道"');
    expect(lines[1]).toBe('"1","t0","t1000","上"');
    expect(lines[2]).toBe('"2","t1000","t2000","下"');
    expect(lines[4]).toBe('"4","t3000","t4000","下"');
    expect(csv).not.toContain('A');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('与真实时间码配合时逗号位于引号内', () => {
    const plan = planOcclusionTracks([cue(0, 1)], []);
    const csv = serializeTrackCsv(plan.items, (ms) =>
      ms === 0 ? '00:00:00,000' : '00:00:00,001',
    );
    expect(csv).toContain('"00:00:00,000"');
  });

  it('轨道标签为中文上/下', () => {
    expect(TRACK_LABEL.top).toBe('上');
    expect(TRACK_LABEL.bottom).toBe('下');
  });
});
