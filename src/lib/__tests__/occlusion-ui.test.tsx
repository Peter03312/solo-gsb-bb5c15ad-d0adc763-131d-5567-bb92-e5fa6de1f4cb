import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OcclusionPanel } from '../../components/OcclusionPanel';
import type { MergedCue } from '../merge';
import {
  parseOcclusions,
  planOcclusionTracks,
  serializeTrackCsv,
} from '../occlusion';
import { formatTimecode } from '../srt';

const noop = () => {};

function renderPanel(
  cues: MergedCue[],
  text: string,
  opts: { sourceReady?: boolean } = {},
) {
  const parsed = parseOcclusions(text);
  const plan = planOcclusionTracks(cues, parsed.occlusions);
  const csv = plan.ok ? serializeTrackCsv(plan.items, formatTimecode) : '';
  const html = renderToString(
    <OcclusionPanel
      sourceCount={cues.length}
      sourceReady={opts.sourceReady ?? true}
      occlusionText={text}
      onOcclusionText={noop}
      parsed={parsed}
      plan={plan}
      csvPreview={csv}
      canDownload={opts.sourceReady !== false && parsed.invalid.length === 0 && plan.ok && parsed.occlusions.length > 0}
      downloadReason={parsed.invalid.length > 0 ? '格式错误' : ''}
      onDownload={noop}
    />,
  ).replace(/<!-- -->/g, '');
  return { html, plan, csv };
}

const cues: MergedCue[] = [
  { start: 0, end: 1000, text: '第一条', groupIndex: 0 },
  { start: 2000, end: 3000, text: '第二条', groupIndex: 1 },
  { start: 4000, end: 5000, text: '第三条', groupIndex: 2 },
];

describe('OcclusionPanel 渲染冒烟', () => {
  it('展示遮挡输入、遮挡依据、上/下轨道预览与 CSV 下载', () => {
    const { html, csv } = renderPanel(cues, '0 1500 下\n4000 5000 上\n');
    expect(html).toContain('遮挡区间列表');
    expect(html).toContain('上传遮挡文件');
    expect(html).toContain('已解析 2 条遮挡');
    expect(html).toContain('遮挡依据');
    expect(html).toContain('轨道预览');
    expect(html).toContain('下载轨道 CSV');
    expect(html).not.toContain('disabled=""');
    // 第 1 条下挡 → 上轨；第 3 条上挡 → 下轨；第 2 条按全局最优
    expect(html).toContain('#1');
    expect(html).toContain('CSV 预览');
    expect(csv).toContain('"序号","开始时间","结束时间","轨道"');
  });

  it('空输入时给出填写提示且不可下载', () => {
    const { html } = renderPanel(cues, '');
    expect(html).toContain('请逐行填写遮挡起止毫秒与位置');
    expect(html).toContain('disabled=""');
  });

  it('格式错误标出物理行号与原因且禁止下载', () => {
    const { html } = renderPanel(cues, '0 1000 上\n坏行\n3000 1000 下');
    expect(html).toContain('第 2、3 行格式错误');
    expect(html).toContain('坏行');
    expect(html).toContain('disabled=""');
  });

  it('某条两轨皆挡时展示首条无解原因、不导出部分方案', () => {
    const { html, plan, csv } = renderPanel(cues, '0 5000 上\n2000 3000 下\n');
    expect(plan.ok).toBe(false);
    expect(plan.items).toEqual([]);
    expect(csv).toBe('');
    expect(html).toContain('两轨均被遮挡');
    expect(html).toContain('不存在可行方案，不导出任何部分轨道方案');
    expect(html).toContain('disabled=""');
  });

  it('上游不可导出时提示且禁止下载', () => {
    const { html } = renderPanel(cues, '0 1000 上', { sourceReady: false });
    expect(html).toContain('上游合并结果当前不可导出');
    expect(html).toContain('disabled=""');
  });

  it('上轨被挡的字幕显示在下轨，轨道计数正确', () => {
    const { html, plan } = renderPanel(cues, '0 6000 上\n');
    expect(plan.ok).toBe(true);
    expect(plan.items.every((i) => i.track === 'bottom')).toBe(true);
    expect(html).toContain('下轨');
    expect(html).toContain('0 条');
  });
});
