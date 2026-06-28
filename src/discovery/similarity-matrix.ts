/**
 * 相似度矩阵构建
 */

import { Vault } from 'obsidian';
import { extractKeywordSet } from '../utils/tokenizer';
import { jaccardSimilarity } from '../utils/jaccard';
import { DEDUP_BATCH_SIZE } from '../constants';
import { DiscoveryIndex, NoteFeature } from './index-manager';

// ─── Types ───

interface DiscoveryCache {
  matrix: number[][] | null;
  notes: NoteMeta[] | null;
  timestamp: number;
}

export interface NoteMeta {
  path: string;
  title: string;
  content: string;
  /** 来自发现索引的预提取关键词集合（索引模式下直接复用） */
  keywords?: string[];
}

/** 发现 Tab 构建相似度矩阵时的可配置参数 */
export interface DiscoveryOptions {
  /** 最大参与计算的笔记数量（默认 500） */
  maxNotes?: number;
  /** 候选笔记的 Jaccard 相似度最低门槛（默认 0.3） */
  jaccardThreshold?: number;
  /** 是否优先使用发现索引，避免重复读文件 */
  useIndex?: boolean;
}

// ─── Cache Manager ───

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * 发现缓存管理器
 */
class DiscoveryCacheManager {
  private discoveryCache: DiscoveryCache = { matrix: null, notes: null, timestamp: 0 };

  /** 清除所有缓存 */
  invalidate(): void {
    this.discoveryCache = { matrix: null, notes: null, timestamp: 0 };
  }

  /** 获取相似度矩阵缓存（若未过期） */
  getDiscovery(): { notes: NoteMeta[]; matrix: number[][] } | null {
    if (this.discoveryCache.matrix && this.discoveryCache.timestamp > Date.now() - CACHE_TTL) {
      return { notes: this.discoveryCache.notes!, matrix: this.discoveryCache.matrix };
    }
    return null;
  }

  /** 更新相似度矩阵缓存 */
  setDiscovery(notes: NoteMeta[], matrix: number[][]): void {
    this.discoveryCache = { matrix, notes, timestamp: Date.now() };
  }
}

/** 全局默认单例，供无插件实例的场景使用 */
const defaultCacheManager = new DiscoveryCacheManager();

/** 手动清除发现 Tab 的相似度矩阵缓存 */
export function invalidateDiscoveryCache(): void {
  defaultCacheManager.invalidate();
}

// ─── Utility ───

/** Strip YAML frontmatter from markdown content */
function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '').trim();
}

// ─── Core Functions ───

/** Build similarity matrix for notes in the vault or target folder */
export async function buildSimilarityMatrix(
  vault: Vault,
  targetFolder?: string,
  cacheManager: DiscoveryCacheManager = defaultCacheManager,
  discoveryIndex?: DiscoveryIndex,
  options: DiscoveryOptions = {},
): Promise<{ notes: NoteMeta[]; matrix: number[][] }> {
  const { maxNotes = 500, useIndex = true } = options;

  // Return cached if valid
  const cached = cacheManager.getDiscovery();
  if (cached) {
    return cached;
  }

  let notes: NoteMeta[] = [];
  let keywordSets: string[][] = [];

  // 优先使用发现索引：避免读文件，支持更大规模
  if (useIndex && discoveryIndex) {
    await discoveryIndex.load();
    const features = discoveryIndex.filterByFolder(targetFolder);
    const sliced = features.slice(0, maxNotes);
    notes = sliced.map((f) => ({
      path: f.path,
      title: f.title,
      content: '', // 索引模式下不保存正文，仅用于占位
      keywords: f.keywords,
    }));
    keywordSets = sliced.map((f) => f.keywords);
  }

  // 索引未启用或为空时，回退到读文件
  if (notes.length === 0) {
    const allFiles = vault.getMarkdownFiles();
    const files = targetFolder
      ? allFiles.filter((f) => f.path === targetFolder || f.path.startsWith(targetFolder + '/'))
      : allFiles;

    const limit = Math.min(files.length, maxNotes);
    for (let i = 0; i < limit; i += DEDUP_BATCH_SIZE) {
      const batch = files.slice(i, i + DEDUP_BATCH_SIZE);
      const batchNotes = await Promise.all(
        batch.map(async (file) => {
          const raw = await vault.read(file);
          const content = stripFrontmatter(raw);
          const title = file.path.split('/').pop()!.replace(/\.md$/, '');
          return { path: file.path, title, content };
        }),
      );
      notes.push(...batchNotes);
    }
  }

  // 构建关键词集合（索引模式下已预生成，回退模式从正文提取）
  if (keywordSets.length === 0) {
    keywordSets = notes.map((n) => extractKeywordSet(n.content));
  }

  // Build similarity matrix (symmetric: 只计算上三角，然后镜像，计算量减半)
  const matrix: number[][] = [];
  for (let i = 0; i < notes.length; i++) {
    matrix[i] = new Array(notes.length).fill(0);
    matrix[i][i] = 1;
  }
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const sim = jaccardSimilarity(keywordSets[i], keywordSets[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }

  // Update cache
  cacheManager.setDiscovery(notes, matrix);
  return { notes, matrix };
}

/**
 * MMR (Maximal Marginal Relevance) 重排
 * 平衡「与查询笔记的相关度」和「与已选笔记的多样性」，避免推荐列表里扎堆相似笔记
 *
 * @param simToQuery 每条笔记与查询笔记的相似度数组（长度 = notes.length）
 * @param simMatrix   全量成对相似度矩阵
 * @param queryIdx   查询笔记在 notes 中的索引
 * @param topK       最终返回数量
 * @param lambda     相关度权重（0=full diversity, 1=full relevance）
 * @returns MMR 重排后的结果列表，每项含 idx 和原始相似度 sim
 */
export function mmrRerank(
  simToQuery: number[],
  simMatrix: number[][],
  queryIdx: number,
  topK: number,
  lambda = 0.6,
): { idx: number; sim: number }[] {
  const n = simToQuery.length;
  const selected: number[] = [];
  const candidates = new Set<number>();

  for (let i = 0; i < n; i++) {
    if (i !== queryIdx) candidates.add(i);
  }

  while (selected.length < topK && candidates.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const c of candidates) {
      const relevance = simToQuery[c];
      let diversityPenalty = 0;
      if (selected.length > 0) {
        let maxSimToSelected = 0;
        for (const s of selected) {
          maxSimToSelected = Math.max(maxSimToSelected, simMatrix[c][s]);
        }
        diversityPenalty = maxSimToSelected;
      }
      const score = lambda * relevance - (1 - lambda) * diversityPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = c;
      }
    }

    if (bestIdx < 0) break;
    selected.push(bestIdx);
    candidates.delete(bestIdx);
  }

  return selected.map((idx) => ({ idx, sim: simToQuery[idx] }));
}
