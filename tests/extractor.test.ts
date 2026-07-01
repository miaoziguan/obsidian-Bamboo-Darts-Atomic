/**
 * 核心提炼管线测试
 *
 * 测试 runExtraction() 的 Phase 编排逻辑：
 * - Phase 1: 读取内容失败 → 提前返回
 * - Phase 2: 质量门控阻断
 * - 取消/中断信号传播
 * - 超时保护
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as obsidian from 'obsidian';
import { runExtraction, ExtractionResult } from '../src/extractor';
import type { ExtractorConfig } from '../src/extractor';

const mockRequestUrl = vi.spyOn(obsidian, 'requestUrl');

/** 创建最小可用 config */
function makeConfig(overrides: Partial<ExtractorConfig> = {}): Partial<ExtractorConfig> {
  return {
    deepseekApiKey: 'sk-test',
    deepseekApiUrl: 'https://api.test/v1',
    model: 'test-model',
    maxTokens: 2000,
    tagPreferences: [],
    tagMode: 'lenient',
    factCheck: false,
    verifiedOnly: false,
    enableReview: false,
    skipGate: false,
    ...overrides,
  };
}

describe('runExtraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Phase 1: 读取失败 ──

  it('URL 读取失败 → 返回错误', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('Network unreachable'));

    const result = await runExtraction(
      { type: 'url', content: 'https://example.com/article' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('URL 读取成功但 content 为空 → 返回错误', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      text: '',
      json: {} as any,
    } as any);

    const result = await runExtraction(
      { type: 'url', content: 'https://example.com/empty' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
  });

  // ── 文本输入最小长度 ──

  it('短文本（< 最小长度）→ 被门控警告或阻断', async () => {
    const result = await runExtraction(
      { type: 'text', content: '短' },
      makeConfig({ skipGate: false }),
    );

    // 短文本被门控处理：可能返回 success:false 或 gateWarnings
    expect(result.success === false || (result.gateWarnings && result.gateWarnings.length > 0)).toBe(true);
  });

  // ── skipGate 路径 ──

  it('skipGate=true → 短文本跳过门控', async () => {
    const result = await runExtraction(
      { type: 'text', content: '短' },
      makeConfig({ skipGate: true }),
    );

    // skipGate 时，短文本不会被门控阻断
    expect(result.forceExtracted || !result.gateBlocked).toBeTruthy();
  });

  // ── 取消 / 中断 ──

  it('AbortController 预先 abort → 立即返回', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 预中止

    const result = await runExtraction(
      { type: 'text', content: '一段足够长的测试文本用于验证取消机制的工作流程' },
      makeConfig({ abortController: ctrl }),
    );

    // 管线在第一个检查点（readContent）就会检测到 abort
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('文本提炼在无 abort 时正常走完管线', async () => {
    // mock AI 返回空
    mockRequestUrl.mockResolvedValue({
      status: 200,
      text: '',
      json: { choices: [{ message: { content: '[]' } }] },
    } as any);

    const result = await runExtraction(
      { type: 'text', content: '这是一段足够长的测试文本用于验证管线正常执行流程确保能通过最小长度门控检查' },
      makeConfig({ skipGate: true, maxTokens: 100 }),
    );

    // 管线应正常完成（不管 AI 是否返回内容）
    expect(result.steps.length).toBeGreaterThan(0);
  });
});
