/**
 * 多轮分段提炼模块（深度模式）
 *
 * 将超长文本分成多段，逐段调用 AI 提炼，合并结果。
 * 仅在 enableDeepMode 且文本超过 INPUT_TRUNCATE_LENGTH 时触发。
 *
 * 已知权衡：段间 CHUNK_OVERLAP 重叠区可能导致相邻分段产出语义相近的笔记，
 * 合并后由 Phase 4 同批交叉去重统一处理，不在此处预去重（避免误杀）。
 */

import { AtomicNote } from '../utils/notes-standards';
import { extractAtomicNotes, ExtractorConfig } from '../extractor';
import { INPUT_TRUNCATE_LENGTH } from '../constants';
import { ProgressTracker } from './progress';

/** 分段提炼的默认重叠字数 */
const CHUNK_OVERLAP = 500;

/** 段间请求间隔（ms），避免 API 限流；可被取消信号中断 */
const CHUNK_DELAY_MS = 200;

/** 可被 AbortSignal 中断的延迟 */
function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('用户取消了提炼'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 将文本按指定大小分段，段间保留重叠
 *
 * 分段策略：优先在段落边界切分，找不到则按句号切分，最后硬切
 */
export function splitContent(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + chunkSize, text.length);

    if (end >= text.length) {
      chunks.push(text.slice(offset));
      break;
    }

    // 尝试在段落边界切分（向前搜索最近的 \n\n）
    let splitPoint = end;
    const lastParagraph = text.lastIndexOf('\n\n', end);
    if (lastParagraph > offset + chunkSize * 0.5) {
      splitPoint = lastParagraph;
    } else {
      // 尝试在句号处切分
      const lastPeriod = text.lastIndexOf('。', end);
      const lastPeriodEn = text.lastIndexOf('. ', end);
      const best = Math.max(lastPeriod, lastPeriodEn);
      if (best > offset + chunkSize * 0.5) {
        splitPoint = best + 1; // 包含句号
      }
    }

    chunks.push(text.slice(offset, splitPoint));

    // 用 previousOffset 检测是否前进，防止死循环
    const previousOffset = offset;
    offset = splitPoint - overlap;
    if (offset < 0) offset = splitPoint;
    // 如果 overlap 导致 offset 不前进，强制跳到 splitPoint
    if (offset <= previousOffset) {
      offset = splitPoint;
    }
  }

  return chunks;
}

/**
 * 多轮分段提炼
 *
 * @param content 原始文本（不做截断，由调用方决定）
 * @param config  提炼配置
 * @param onProgress 进度回调
 * @returns 合并后的原子笔记数组（未去重）
 */
export async function extractChunked(
  content: string,
  config: Partial<ExtractorConfig>,
  chunkSize: number | undefined,
  tracker: ProgressTracker,
): Promise<AtomicNote[]> {
  const effectiveChunkSize = chunkSize && chunkSize >= 1000 ? chunkSize : INPUT_TRUNCATE_LENGTH;
  const chunks = splitContent(content, effectiveChunkSize, CHUNK_OVERLAP);
  const allNotes: AtomicNote[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const label = `第${i + 1}/${chunks.length}轮`;

    // 每段开始前检查是否已取消，避免取消后仍继续调用 API
    if (config.signal?.aborted) {
      tracker.update({ detail: '已取消', status: 'failed' });
      break;
    }

    tracker.update({ detail: `${label}：处理 ${chunk.length} 字...` });

    const result = await extractAtomicNotes(chunk, config);

    if (result.success && result.notes) {
      allNotes.push(...result.notes);
      successCount++;
    } else {
      failCount++;
      tracker.update({
        detail: `${label}：失败 — ${result.error || '未知错误'}`,
        status: 'failed',
      });

      // 连续失败且无任何成功产出，提前中止，避免浪费 API 调用
      if (failCount >= 3 && successCount === 0) break;
    }

    // 段间延迟：可被取消信号中断
    if (i < chunks.length - 1) {
      try {
        await interruptibleDelay(CHUNK_DELAY_MS, config.signal);
      } catch {
        tracker.update({ detail: '已取消', status: 'failed' });
        break;
      }
    }
  }

  return allNotes;
}
