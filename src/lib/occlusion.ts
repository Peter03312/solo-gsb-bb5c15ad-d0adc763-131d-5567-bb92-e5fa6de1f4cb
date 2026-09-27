/**
 * 字幕遮挡避让（独立模块）：读取现有最终合并字幕（finalCues）的时间与文本，
 * 用户逐行录入遮挡区间（起止毫秒）与其位置（上/下），系统为每条字幕在
 * 「上轨 / 下轨」两条显示轨道中选一条，使其半开时间区间不与同位置的任何
 * 遮挡区间产生正时长重叠。
 *
 * 输入规则（每行三列）：
 *   起点毫秒 终点毫秒 位置
 *   - 起止均为非负整数，且起点 < 终点（物理行号即报错行号）；
 *   - 位置取 上/下（兼容 top/bottom、up/down、上方/下方、上轨/下轨）；
 *   - 允许任意顺序、重复、重叠的遮挡行（不排序、不去重）；
 *   - 半开区间重叠口径：max(aStart,bStart) < min(aEnd,bEnd)，
 *     即只有一个公共时间点（相切）不算重叠；同位置的遮挡行彼此重叠合法，
 *     只有“某字幕在该轨道被挡住”才有意义。
 *
 * 选轨目标（按字典序依次最小化）：
 *   ① 相邻字幕切换轨道的次数；
 *   ② 改到上轨的条数（默认下轨）；
 *   ③ 仍并列表述时，按字幕顺序更早处优先下轨（字典序：下 < 上）。
 *
 * 这是一个逐字幕的两状态（上/下）动态规划：状态 i∈轨道 的代价为到第 i 条
 * 为止的前缀最优。切换代价按“相邻条轨道是否不同”累加，上轨代价按
 * “本条是否在上轨”累加；目标三元组编码为单个大整数（2 个 n 位二进制 +
 * 一个 n 位轨道序列，低位优先存放较早字幕，使“更早处优先下轨”自动成为
 * 数值更小者），同值状态只需比较一个 BigInt 即可完成三层字典序比较。
 *
 * 任一字幕两轨都被遮挡时不存在全局方案：返回 ok:false 与首条无解字幕的
 * 原因（上、下分别命中哪条遮挡行），不产出任何部分方案、禁止导出。
 *
 * 本模块只读取上游结果，绝不修改合并结果，也不改动 SRT；导出为独立的
 * CSV（字幕序号、起止时间、轨道）。
 */

export type TrackSide = 'top' | 'bottom';

export interface Occlusion {
  /** 物理行号（从 1 起，空行也计入，与文本框行号一致） */
  line: number;
  /** 遮挡起点（毫秒） */
  start: number;
  /** 遮挡终点（毫秒，严格大于起点） */
  end: number;
  /** 遮挡位置：上轨 / 下轨 */
  side: TrackSide;
}

export interface BadOcclusionLine {
  /** 物理行号（从 1 起） */
  line: number;
  raw: string;
  /** 错误原因 */
  reason: string;
}

export interface OcclusionParseResult {
  /** 解析成功的遮挡行（保持填写顺序） */
  occlusions: Occlusion[];
  /** 格式错误的行 */
  invalid: BadOcclusionLine[];
  /** 非空物理行总数（含错误行） */
  totalLines: number;
}

const SIDE_LABEL: Record<TrackSide, string> = { top: '上轨', bottom: '下轨' };

/** 把用户填写的位置词归一化为上/下；无法识别返回 null。 */
export function parseSide(raw: string): TrackSide | null {
  const s = raw.trim().toLowerCase();
  if (s === '上' || s === '上方' || s === '上轨' || s === 'top' || s === 'up') return 'top';
  if (s === '下' || s === '下方' || s === '下轨' || s === 'bottom' || s === 'down') return 'bottom';
  return null;
}

/**
 * 解析遮挡列表：每行「起点 终点 位置」三列。空行忽略；列数、非负整数、
 * 起点 < 终点、位置词任一不合法都按物理行标出原因。
 */
export function parseOcclusions(text: string): OcclusionParseResult {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const occlusions: Occlusion[] = [];
  const invalid: BadOcclusionLine[] = [];
  let totalLines = 0;

  normalized.split('\n').forEach((rawLine, idx) => {
    const raw = rawLine.trim();
    if (!raw) return;
    totalLines++;
    const line = idx + 1;
    // 常见分隔：连续空白（含 Tab）、逗号/中文逗号、分号/中文分号、箭头与波浪号。
    // 故意不把单横线 “-” 当分隔符：负数（如 -1000）必须判为非法。
    const parts = raw
      .split(/\s+|[,，;；]|-->|~|～/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length !== 3) {
      invalid.push({
        line,
        raw,
        reason:
          parts.length < 3
            ? '需要三个字段（起点 终点 上/下）'
            : '每行只能填写起点、终点与位置三个字段',
      });
      return;
    }
    const [a, b, posRaw] = parts;
    const intRe = /^(?:0|[1-9][0-9]*)$/;
    if (!intRe.test(a) || !intRe.test(b)) {
      invalid.push({ line, raw, reason: '起止必须是非负整数（毫秒）' });
      return;
    }
    const start = Number(a);
    const end = Number(b);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      invalid.push({ line, raw, reason: '数值超出安全整数范围' });
      return;
    }
    if (start >= end) {
      invalid.push({ line, raw, reason: `起点必须小于终点（${start} ≥ ${end}）` });
      return;
    }
    const side = parseSide(posRaw);
    if (side === null) {
      invalid.push({ line, raw, reason: `位置必须是“上”或“下”（实际为“${posRaw}”）` });
      return;
    }
    occlusions.push({ line, start, end, side });
  });

  return { occlusions, invalid, totalLines };
}

/**
 * 半开区间 [aStart,aEnd) 与 [bStart,bEnd) 是否有正时长重叠；
 * 仅端点相切（max == min）不算重叠。
 */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

/** 命中某字幕某轨道的遮挡行（按填写顺序返回，便于界面给出依据）。 */
export function blockingOcclusions(
  cueStart: number,
  cueEnd: number,
  side: TrackSide,
  occlusions: Occlusion[],
): Occlusion[] {
  return occlusions.filter(
    (o) => o.side === side && overlaps(cueStart, cueEnd, o.start, o.end),
  );
}

export interface OcclusionItem {
  /** cue 下标（与输入一一对齐） */
  index: number;
  start: number;
  end: number;
  text: string;
  /** 方案选择的轨道 */
  track: TrackSide;
  /** 上轨命中的遮挡行（依据；为空表示上轨可用） */
  topBlocked: Occlusion[];
  /** 下轨命中的遮挡行（依据；为空表示下轨可用） */
  bottomBlocked: Occlusion[];
}

export interface OcclusionPlan {
  /** 是否存在满足全部遮挡约束的方案 */
  ok: boolean;
  /** 不可行原因（ok 时为空串）：首条两轨均被遮挡的字幕 */
  reason: string;
  /** 无解字幕的 1 基序号（ok 时为 −1） */
  blockedIndex: number;
  /** 与输入 cues 一一对齐的逐条方案（不可行时为空数组，不导出部分方案） */
  items: OcclusionItem[];
  /** 相邻字幕切换轨道次数 */
  switches: number;
  /** 改到上轨的条数 */
  topCount: number;
  /** 每条遮挡行（按物理行号）实际挡住多少条字幕；无解时同样可用作依据 */
  lineHits: ReadonlyMap<number, number>;
}

interface CueLike {
  start: number;
  end: number;
  text: string;
}

const SIDES: TrackSide[] = ['bottom', 'top'];

/** 人类可读的遮挡区间描述（用于无解原因与悬浮提示）。 */
export function describeOcclusion(o: Occlusion): string {
  return `第 ${o.line} 行 ${SIDE_LABEL[o.side]}遮挡 [${o.start}, ${o.end})`;
}

/**
 * 全局动态规划求最优轨道方案。目标按字典序：切换次数 → 上轨条数 →
 * 按字幕顺序优先下轨。任一条两轨都被遮挡即无全局解，返回首条原因。
 */
export function planOcclusionTracks(
  cues: CueLike[],
  occlusions: Occlusion[],
): OcclusionPlan {
  const n = cues.length;
  if (n === 0) {
    return {
      ok: true,
      reason: '',
      blockedIndex: -1,
      items: [],
      switches: 0,
      topCount: 0,
      lineHits: new Map(),
    };
  }

  // 每条字幕在两轨上分别命中的遮挡行（同时充当可行性与界面依据）
  const blocked: Record<TrackSide, Occlusion[]>[] = cues.map((c) => ({
    top: blockingOcclusions(c.start, c.end, 'top', occlusions),
    bottom: blockingOcclusions(c.start, c.end, 'bottom', occlusions),
  }));

  // 每行遮挡挡住多少条字幕（无解时也要作为依据展示，故提前统计）
  const lineHits = new Map<number, number>();
  for (const b of blocked) {
    for (const o of b.top) lineHits.set(o.line, (lineHits.get(o.line) ?? 0) + 1);
    for (const o of b.bottom) lineHits.set(o.line, (lineHits.get(o.line) ?? 0) + 1);
  }

  for (let i = 0; i < n; i++) {
    if (blocked[i].top.length > 0 && blocked[i].bottom.length > 0) {
      const c = cues[i];
      const reason =
        `第 ${i + 1} 条字幕（${c.start}–${c.end} ms）上、下两轨均被遮挡：` +
        `${describeOcclusion(blocked[i].top[0]!)}；${describeOcclusion(blocked[i].bottom[0]!)}`;
      return {
        ok: false,
        reason,
        blockedIndex: i + 1,
        items: [],
        switches: 0,
        topCount: 0,
        lineHits,
      };
    }
  }

  // 目标编码（共 3n 位）：低 n 位为轨道序列（第 i 位置 1 = 第 i 条在上轨，
  // 低位存较早字幕），中 n 位为“上轨条数”计数，高 n 位为“切换次数”计数。
  // 数值比较即严格按 ① 切换 ② 上轨条数 ③ 序列字典序（更早处下轨优先）。
  // 计数区只加基数（switchBase/topBase），逐位信息全部由低位序列承担。
  const seqBits = BigInt(n);
  const topBase = 1n << seqBits;
  const switchBase = 1n << (2n * seqBits);
  const ONE = 1n;

  // 滚动两阶段：dp[side] 为截至上一条且上一条落在 side 时的最优编码
  let dp: Record<TrackSide, bigint | null> = { top: null, bottom: null };
  // 每阶段每状态记录其前驱轨道，用于回溯（首条前驱记为自身）
  const back: (Record<TrackSide, TrackSide>)[] = [];

  for (let i = 0; i < n; i++) {
    const bit = ONE << BigInt(i);
    const next: Record<TrackSide, bigint | null> = { top: null, bottom: null };
    const prevBack: Record<TrackSide, TrackSide> = { top: 'bottom', bottom: 'bottom' };

    for (const side of SIDES) {
      if (blocked[i][side].length > 0) continue;
      const topCost = side === 'top' ? topBase : 0n;
      const seqCost = side === 'top' ? bit : 0n;
      if (i === 0) {
        next[side] = topCost + seqCost;
        prevBack[side] = side;
        continue;
      }
      let best: bigint | null = null;
      let bestPrev: TrackSide = 'bottom';
      // 前驱按下轨优先枚举：编码完全相等（多重最优）时自然保留下轨前驱，
      // 与“并列按字幕顺序优先下轨”一致；正常情况下编码已含序列位，不会相等。
      for (const prev of SIDES) {
        const prevScore = dp[prev];
        if (prevScore === null) continue;
        // 切换 / 上轨只需累加计数基数；逐位的序列区已单独承担字典序
        const switchCost = prev !== side ? switchBase : 0n;
        const cand = prevScore + switchCost + topCost + seqCost;
        if (best === null || cand < best) {
          best = cand;
          bestPrev = prev;
        }
      }
      if (best !== null) {
        next[side] = best;
        prevBack[side] = bestPrev;
      }
    }

    back.push(prevBack);
    dp = next;
  }

  // 末阶段取优（编码比较已含全部三层字典序）
  let endSide: TrackSide = 'bottom';
  let bestScore: bigint | null = null;
  for (const side of SIDES) {
    const s = dp[side];
    if (s !== null && (bestScore === null || s < bestScore)) {
      bestScore = s;
      endSide = side;
    }
  }
  // 前面已排除“某条两轨皆挡”，故必有解
  if (bestScore === null) {
    return {
      ok: false,
      reason: '不存在可行轨道方案',
      blockedIndex: -1,
      items: [],
      switches: 0,
      topCount: 0,
      lineHits,
    };
  }

  const tracks = new Array<TrackSide>(n);
  let side: TrackSide = endSide;
  for (let i = n - 1; i >= 0; i--) {
    tracks[i] = side;
    side = back[i][side];
  }

  let switches = 0;
  let topCount = 0;
  const items: OcclusionItem[] = cues.map((c, i) => {
    if (tracks[i] === 'top') topCount++;
    if (i > 0 && tracks[i] !== tracks[i - 1]) switches++;
    return {
      index: i,
      start: c.start,
      end: c.end,
      text: c.text,
      track: tracks[i],
      topBlocked: blocked[i].top,
      bottomBlocked: blocked[i].bottom,
    };
  });

  return { ok: true, reason: '', blockedIndex: -1, items, switches, topCount, lineHits };
}

/** 轨道的 CSV/界面中文值。 */
export const TRACK_LABEL: Record<TrackSide, string> = { top: '上', bottom: '下' };

function csvCell(value: string): string {
  // 时间码含逗号，统一按 RFC 4180 加双引号；内部双引号转义为两个双引号
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 序列化为独立 CSV：字幕序号（1 基）、开始时间、结束时间、轨道（上/下）。
 * 时间码使用 SRT 风格 HH:MM:SS,mmm（故整行加引号），CRLF 换行。
 * 不改动、也不内嵌 SRT 文本。
 */
export function serializeTrackCsv(items: OcclusionItem[], formatTime: (ms: number) => string): string {
  const header = ['序号', '开始时间', '结束时间', '轨道'].map(csvCell).join(',');
  const rows = items.map((it) =>
    [
      String(it.index + 1),
      formatTime(it.start),
      formatTime(it.end),
      TRACK_LABEL[it.track],
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...rows].join('\r\n') + '\r\n';
}
