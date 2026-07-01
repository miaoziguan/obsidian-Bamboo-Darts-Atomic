/**
 * 核查管线单元测试
 *
 * verifyClaims() 三层管线：Layer 1 原文溯源 → Layer 2 AI 语义比对 → Layer 3 超源标记
 * 通过 mock requestUrl 隔离外部 API，验证管线分支逻辑和结果汇总。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as obsidian from 'obsidian';
import { verifyClaims, VerificationResult } from '../src/extraction/fact-checker';
import type { AtomicNote } from '../src/utils/notes-standards';

const mockRequestUrl = vi.spyOn(obsidian, 'requestUrl');

function makeNote(title: string, content: string): AtomicNote {
  return { title, content, tags: [] } as AtomicNote;
}

function verifyNotes(
  truncated: string,
  notes: AtomicNote[],
  apiKey = 'sk-test',
): Promise<VerificationResult> {
  return verifyClaims(truncated, notes, {
    deepseekApiKey: apiKey,
    deepseekApiUrl: 'https://api.test/v1',
  }, truncated);
}

/** AI 返回空数组（所有声明降级超源） */
function mockEmptyAI() {
  mockRequestUrl.mockResolvedValueOnce({
    status: 200,
    text: '',
    json: { choices: [{ message: { content: '[]' } }] },
  } as any);
}

/** API 异常 */
function mockAIFailure(msg = 'Network Error') {
  mockRequestUrl.mockRejectedValueOnce(new Error(msg));
}

describe('verifyClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 边界 ──

  it('空 notes 数组返回全零', async () => {
    const r = await verifyNotes('原文', []);
    expect(r.traced).toBe(0);
    expect(r.needsCompare).toBe(0);
    expect(r.outOfScope).toBe(0);
  });

  it('无任何可验证声明时全零', async () => {
    const r = await verifyNotes('原文', [makeNote('n1', '纯叙述，无数据。')]);
    expect(r.traced).toBe(0);
    expect(r.needsCompare).toBe(0);
    expect(r.outOfScope).toBe(0);
  });

  // ── Layer 1 命中 ──

  it('声明数值可精确定位（Layer 1 全部命中）', async () => {
    const content = '2024年营收150亿元，利润增长23%。';
    const r = await verifyNotes(content, [
      makeNote('n1', '营收150亿元，增长23%。'),
    ]);
    // 150亿元 和 23% 两条都在原文中
    expect(r.traced).toBe(2);
    expect(r.needsCompare).toBe(0);
    expect(r.outOfScope).toBe(0);
  });

  // ── Layer 1 未命中 → Layer 2/3 ──

  it('未命中声明被 AI 标记为超源', async () => {
    mockEmptyAI();
    const r = await verifyNotes('无关原文。', [
      makeNote('n1', '营收150亿元。'),
    ]);
    // AI 返回空 → 超源
    expect(r.outOfScope).toBe(1);
    expect(r.traced).toBe(0);
    // needsCompare 仅统计 AI 返回'需对比'的声明
    expect(r.needsCompare).toBe(0);
  });

  it('API 失败时所有未命中降级超源', async () => {
    mockAIFailure();
    const r = await verifyNotes('无关原文。', [
      makeNote('n1', '营收150亿元。'),
    ]);
    expect(r.outOfScope).toBe(1);
    expect(r.traced).toBe(0);
  });

  it('混合：Layer 1 命中 + Layer 2 超源', async () => {
    mockEmptyAI();
    const content = '公司年营收100亿元，利润20亿元。';
    const notes = [
      makeNote('n1', '营收100亿元。'),
      makeNote('n2', '利润20亿元。'),
      makeNote('n3', '市占率35%。'),
    ];

    const r = await verifyNotes(content, notes);
    // 前两条 Layer 1 命中，第三条 AI 返回空 → 超源
    expect(r.traced).toBe(2);
    expect(r.outOfScope).toBe(1);
    expect(r.needsCompare).toBe(0);
  });

  it('AI 部分验证成功（需对比 + 超源混合）', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '',
      json: {
        choices: [{
          message: {
            content: JSON.stringify([
              { index: 0, status: '需对比', sourceText: '原文引用', diffNote: '略有出入' },
            ]),
          },
        }],
      },
    } as any);

    const r = await verifyNotes('无关原文。', [
      makeNote('n1', '增长50%。'),
      makeNote('n2', '营收25亿元。'),
    ]);

    // mock 被正确调用
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    // 两条声明都在 Layer 2 处理后产生了结果
    expect(r.needsCompare + r.outOfScope).toBe(2);
    expect(r.traced).toBe(0);
  });

  it('大量声明触发截断', async () => {
    const parts: string[] = [];
    for (let i = 1; i <= 50; i++) {
      parts.push(`指标${i}达到${i * 10}%。`);
    }
    const r = await verifyNotes('无关原文', [makeNote('n1', parts.join(' '))]);
    // 上限为 30，超出部分截断
    expect(r.needsCompare + r.outOfScope).toBeLessThanOrEqual(30);
  });

  it('verification 字段正确附加到 notes', async () => {
    const content = '公司营收150亿元。';
    const r = await verifyNotes(content, [makeNote('n1', '营收150亿元。')]);

    expect(r.notes[0].verification).toBeDefined();
    expect(r.notes[0].verification!.length).toBe(1);
    expect(r.notes[0].tracedCount).toBe(1);
  });
});
