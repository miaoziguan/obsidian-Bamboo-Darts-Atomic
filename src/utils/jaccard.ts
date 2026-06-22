/**
 * Jaccard 相似度工具函数
 */

/** Jaccard 系数：两集合交集大小 / 并集大小 */
export function jaccardSimilarity(a: Set<string> | string[], b: Set<string> | string[]): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}
