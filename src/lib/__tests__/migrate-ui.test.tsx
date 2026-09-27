import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecalibrateMigrateDialog } from '../../components/RecalibrateMigrateDialog';
import { alignCues } from '../align';
import { defaultStateFor } from '../merge';
import { migrateStates, planMigration } from '../migrate';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt } from '../srt';

const noop = () => {};

describe('重新校准迁移弹窗', () => {
  it('未打开时不渲染', () => {
    const html = renderToString(
      <RecalibrateMigrateDialog
        open={false}
        busy={false}
        oldGroupCount={0}
        newGroups={null}
        newCuesA={[]}
        newCuesB={[]}
        plan={null}
        calibrated={false}
        anchorCount={0}
        onClose={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toBe('');
  });

  it('busy 时提示正在重新对齐', () => {
    const html = renderToString(
      <RecalibrateMigrateDialog
        open
        busy
        oldGroupCount={0}
        newGroups={null}
        newCuesA={[]}
        newCuesB={[]}
        plan={null}
        calibrated
        anchorCount={4}
        onClose={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('重新对齐');
  });

  it('展示可迁移/歧义/无对应统计与明细，并标明一次提交、取消保留旧工作区', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const groups = alignCues(a, b);
    // 同一对齐作为“新对齐”：所有组内容一致，理论上全部可迁移
    const plan = planMigration(groups, groups, a, b);
    const html = renderToString(
      <RecalibrateMigrateDialog
        open
        busy={false}
        oldGroupCount={groups.length}
        newGroups={groups}
        newCuesA={a}
        newCuesB={b}
        plan={plan}
        calibrated
        anchorCount={5}
        onClose={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('重新校准并迁移审校决定');
    expect(html).toContain(`可迁移`);
    expect(html).toContain(`无对应`);
    expect(html).toContain('确认并一次提交');
    expect(html).toContain('取消（保留旧工作区）');
    expect(html).toContain('时间选择一律使用新组默认值');
  });

  it('端到端：同方案重新校准后所有已决定都能迁移，时间选择回到新默认', () => {
    const a = parseSrt(SAMPLE_A);
    const b = parseSrt(SAMPLE_B);
    const groups = alignCues(a, b);
    const plan = planMigration(groups, groups, a, b);
    expect(plan.ok).toBe(true);
    expect(plan.ambiguous).toHaveLength(0);
    const oldStates = groups.map((g) => defaultStateFor(g, a, b));
    const newBase = groups.map((g) => defaultStateFor(g, a, b));
    const out = migrateStates(groups, newBase, oldStates, plan);
    expect(out).toHaveLength(groups.length);
    // 新组默认状态都合法
    for (const s of out) {
      expect(s.resolution.time).toMatch(/^(A|B|union|custom)$/);
      expect(s.resolution.customStart).toBe('');
    }
  });
});
