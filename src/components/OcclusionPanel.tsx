import { useMemo, useRef, useState } from 'react';
import {
  describeOcclusion,
  TRACK_LABEL,
  type OcclusionParseResult,
  type OcclusionPlan,
  type TrackSide,
} from '../lib/occlusion';
import { formatTimecode } from '../lib/srt';

const PAGE = 50;

interface OcclusionPanelProps {
  /** 上游最终字幕条数（只读，绝不修改合并结果与 SRT） */
  sourceCount: number;
  /** 上游合并结果当前是否可导出（无未解决冲突 / 校验错误 / 非空） */
  sourceReady: boolean;
  /** 遮挡列表原文（文本框） */
  occlusionText: string;
  onOcclusionText(text: string): void;
  /** 遮挡列表解析结果 */
  parsed: OcclusionParseResult;
  /** 当前遮挡列表在最终字幕上求出的轨道方案 */
  plan: OcclusionPlan;
  /** CSV 预览文本 */
  csvPreview: string;
  /** 是否允许下载 CSV */
  canDownload: boolean;
  /** 不允许下载时的原因 */
  downloadReason: string;
  onDownload(): void;
}

const SIDE_CLS: Record<TrackSide, string> = { top: 'warn', bottom: 'go' };

const firstLine = (text: string) => text.split('\n')[0] ?? '';

function OcclusionRow({ o }: { o: OcclusionParseResult['occlusions'][number] }) {
  return (
    <div className="occ-block">
      <span className="g-idx">第 {o.line} 行</span>
      <span className={`tag ${SIDE_CLS[o.side]}`}>{TRACK_LABEL[o.side]}轨遮挡</span>
      <span className="mono edit-time">
        {formatTimecode(o.start)} → {formatTimecode(o.end)}
      </span>
      <span className="tag dim">{o.end - o.start} ms</span>
    </div>
  );
}

export function OcclusionPanel(props: OcclusionPanelProps) {
  const { parsed, plan, occlusionText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const nonEmptyLines = useMemo(
    () => occlusionText.split('\n').filter((l) => l.trim().length > 0).length,
    [occlusionText],
  );
  const hasError = parsed.invalid.length > 0;

  // 每条遮挡行实际挡住多少条字幕（预览“遮挡依据”；无解时同样准确）
  const hitByLine = props.plan.lineHits;

  const topItems = useMemo(
    () => (plan.ok ? plan.items.filter((it) => it.track === 'top') : []),
    [plan],
  );
  const bottomItems = useMemo(
    () => (plan.ok ? plan.items.filter((it) => it.track === 'bottom') : []),
    [plan],
  );

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onOcclusionText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const renderLane = (side: TrackSide, items: typeof topItems) => (
    <div className={`occ-lane ${side}`}>
      <h4 className="occ-lane-head">
        <span className={`tag ${SIDE_CLS[side]}`}>{TRACK_LABEL[side]}轨</span>
        <span className="tag dim">{items.length} 条</span>
      </h4>
      {items.length === 0 ? (
        <div className="empty occ-lane-empty">本轨道没有字幕</div>
      ) : (
        items.map((it) => {
          // 本轨为选中轨道，恒无遮挡；展示另一轨的遮挡作为“为何避让到本轨”的依据
          const otherBlocked = side === 'top' ? it.bottomBlocked : it.topBlocked;
          return (
            <div className="occ-cue" key={it.index}>
              <span className="g-idx">#{it.index + 1}</span>
              <span className="mono cue-time">
                {formatTimecode(it.start)} → {formatTimecode(it.end)}
              </span>
              <span className="occ-cue-text" title={it.text}>
                {firstLine(it.text) || '（无文本）'}
              </span>
              {otherBlocked.length > 0 ? (
                <span
                  className="tag warn occ-basis"
                  title={`另一轨与以下遮挡重叠：${otherBlocked.map(describeOcclusion).join('；')}`}
                >
                  另一轨被 {otherBlocked.length} 处遮挡 → 避让至{TRACK_LABEL[side]}轨
                </span>
              ) : (
                <span className="tag dim occ-basis">两轨均可用 · 默认下轨优先</span>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <section className="wrap-panel edit-panel occ-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>遮挡区间列表</strong>
          <span className="tag dim">每行：起点毫秒 终点毫秒 上/下</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传遮挡文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.tsv,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          {occlusionText.length > 0 && (
            <button className="btn sm" onClick={() => props.onOcclusionText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste"
          placeholder={'逐行填写遮挡的起止毫秒与位置（上/下），例如：\n5000 12000 上\n20000 26500 下\n0 3000 上\n位置兼容 上/下、上方/下方、上轨/下轨、top/bottom'}
          value={occlusionText}
          spellCheck={false}
          onChange={(e) => props.onOcclusionText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {!hasError ? (
              <span className="tag ok">
                ✓ 已解析 {parsed.occlusions.length} 条遮挡（上轨{' '}
                {parsed.occlusions.filter((o) => o.side === 'top').length} · 下轨{' '}
                {parsed.occlusions.filter((o) => o.side === 'bottom').length}）
              </span>
            ) : (
              <span className="tag warn">
                ⚠ 第 {parsed.invalid.map((b) => b.line).join('、')} 行格式错误
                {parsed.occlusions.length > 0 && `，其余 ${parsed.occlusions.length} 行已解析`}
              </span>
            )}
            {parsed.invalid.slice(0, 5).map((b) => (
              <span className="snap-badline" key={b.line} title={b.reason}>
                第 {b.line} 行：{b.raw}（{b.reason}）
              </span>
            ))}
            {parsed.invalid.length > 5 && (
              <span className="snap-badline">…等 {parsed.invalid.length} 行</span>
            )}
          </div>
        )}
      </div>

      <div className="wrap-summary">
        上游最终字幕 {props.sourceCount} 条（只读） · 遮挡 {parsed.occlusions.length} 条
        {plan.ok && (
          <>
            {' '}· 方案切换 <strong>{plan.switches}</strong> 次 · 上轨 {plan.topCount} 条 ·
            下轨 {plan.items.length - plan.topCount} 条
          </>
        )}
        <span className="wrap-hint">
          字幕与同位置遮挡按半开区间 [起点,终点) 判定，相切不算重叠；全局依次最小化相邻切换次数、
          改到上轨条数，并列时按字幕顺序优先下轨；默认下轨
        </span>
      </div>

      {!props.sourceReady && (
        <div className="we-fail">
          ⚠ 上游合并结果当前不可导出（仍有未解决冲突或校验错误，或结果为空）。遮挡避让模块只读展示，
          修正上游前禁止下载轨道 CSV。
        </div>
      )}

      {parsed.occlusions.length > 0 && (
        <>
          <h3 className="panel-sub edit-sub">遮挡依据（按录入行序）</h3>
          <div className="edit-segtable">
            {parsed.occlusions.map((o) => (
              <div className="occ-block-wrap" key={o.line}>
                <OcclusionRow o={o} />
                <span className="tag dim occ-hit">
                  {hitByLine.get(o.line) ?? 0} 条字幕在该轨道被挡
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {!plan.ok && parsed.invalid.length === 0 && (
        <div className="we-fail">⚠ {plan.reason}。不存在可行方案，不导出任何部分轨道方案。</div>
      )}

      <h3 className="panel-sub edit-sub">轨道预览（上 / 下）</h3>
      {parsed.occlusions.length === 0 ? (
        <div className="empty">
          请逐行填写遮挡起止毫秒与位置（非负整数、起点小于终点、位置为上/下），
          系统将立即为每条字幕选择避让轨道。
        </div>
      ) : !plan.ok ? (
        <div className="empty">方案无解：{plan.reason}。请调整遮挡列表后再试。</div>
      ) : (
        <>
          <div className="occ-lanes">
            {renderLane('top', topItems)}
            {renderLane('bottom', bottomItems)}
          </div>

          <h3 className="panel-sub edit-sub">逐条方案（前 {Math.min(shown, plan.items.length)} 条）</h3>
          <div className="wrap-list">
            {plan.items.slice(0, shown).map((it, i) => {
              const switched = i > 0 && it.track !== plan.items[i - 1]!.track;
              const chosenBlocked = it.track === 'top' ? it.topBlocked : it.bottomBlocked;
              const otherBlocked = it.track === 'top' ? it.bottomBlocked : it.topBlocked;
              return (
                <article className={`wrap-entry occ-entry ${it.track}`} key={it.index}>
                  <div className="we-head">
                    <span className="g-idx">#{it.index + 1}</span>
                    <span className="cue-time mono">
                      {formatTimecode(it.start)} → {formatTimecode(it.end)}
                    </span>
                    <span className={`tag ${SIDE_CLS[it.track]}`}>{TRACK_LABEL[it.track]}轨</span>
                    {switched && <span className="tag low">相对上一条切换轨道</span>}
                    <span className="spacer" />
                    {otherBlocked.length > 0 && (
                      <span
                        className="tag warn"
                        title={otherBlocked.map(describeOcclusion).join('；')}
                      >
                        另一轨被 {otherBlocked.length} 处遮挡 → 避让至{TRACK_LABEL[it.track]}轨
                      </span>
                    )}
                    {otherBlocked.length === 0 && chosenBlocked.length === 0 && (
                      <span className="tag dim">两轨均可用 · 默认下轨优先</span>
                    )}
                  </div>
                  <pre className="snap-text">{it.text}</pre>
                </article>
              );
            })}
          </div>
          {plan.items.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {plan.items.length - shown} 条）
            </button>
          )}

          <h3 className="panel-sub edit-sub">CSV 预览（不改变 SRT）</h3>
          <pre className="preview edit-preview occ-csv">{props.csvPreview || '（暂无内容）'}</pre>
        </>
      )}

      <button
        className="btn primary lg block"
        disabled={!props.canDownload}
        title={props.canDownload ? '下载 occlusion-tracks.csv' : props.downloadReason}
        onClick={props.onDownload}
      >
        {props.canDownload ? '下载轨道 CSV' : props.downloadReason || '暂不可下载'}
      </button>
    </section>
  );
}
