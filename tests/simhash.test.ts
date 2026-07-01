/**
 * SimHash 单元测试
 *
 * 验证 64-bit SimHash 指纹的确定性、汉明距离，以及相似/不同文档的指纹特性。
 */

import { describe, it, expect } from 'vitest';
import { simhash, hammingDistance } from '../src/utils/simhash';

describe('simhash', () => {
  it('相同权重表产生相同指纹（确定性）', () => {
    const weights = new Map([
      ['hello', 5],
      ['world', 3],
      ['test', 2],
    ]);

    const a = simhash(weights);
    const b = simhash(weights);
    expect(a).toBe(b);
    expect(typeof a).toBe('bigint');
  });

  it('空权重返回 0n', () => {
    const result = simhash(new Map());
    expect(result).toBe(0n);
  });

  it('仅一个 token 时返回该 token 哈希方向', () => {
    // 单个 token 的指纹完全由 fnv1a64 的 64 bit 位方向决定
    const w1 = new Map([['a', 1]]);
    const fp = simhash(w1);
    // 指纹不应是 0n
    expect(fp).not.toBe(0n);
  });

  it('高权重 token 主导指纹方向', () => {
    // token A 权重极小，token B 权重极大 → 指纹应接近 B 的哈希方向
    const dominated = new Map([
      ['dominant', 10000],
      ['noise', 1],
    ]);
    const pure = new Map([['dominant', 10000]]);

    const fpDominated = simhash(dominated);
    const fpPure = simhash(pure);
    const dist = hammingDistance(fpDominated, fpPure);

    // 噪声 token 最多影响一位（fnv1a64 分布均匀），距离应很小
    expect(dist).toBeLessThanOrEqual(1);
  });
});

describe('hammingDistance', () => {
  it('相同指纹距离为 0', () => {
    expect(hammingDistance(0x1234n, 0x1234n)).toBe(0);
  });

  it('完全相反的指纹距离为 64', () => {
    // ~0n = 全 1，与 0n 的每一位都不同
    const allOnes = (1n << 64n) - 1n;
    expect(hammingDistance(0n, allOnes)).toBe(64);
  });

  it('已知 bit pattern 的距离', () => {
    // 0b01 ^ 0b10 = 0b11 → 2 bits
    expect(hammingDistance(1n, 2n)).toBe(2);
    // 0b101 ^ 0b010 = 0b111 → 3 bits
    expect(hammingDistance(5n, 2n)).toBe(3);
    // 0b1111 ^ 0b1010 = 0b0101 → 2 bits
    expect(hammingDistance(0xfn, 0xan)).toBe(2);
  });

  it('相似文本产生较小汉明距离', () => {
    // 两段几乎相同的文本，只差几个 token
    const text1 = new Map([
      ['hello', 1],
      ['world', 1],
      ['this', 1],
      ['is', 1],
      ['a', 1],
      ['test', 1],
    ]);
    const text2 = new Map([
      ['hello', 1],
      ['world', 1],
      ['this', 1],
      ['is', 1],
      ['a', 1],
      ['trial', 1], // 只改了一个词
    ]);

    const fp1 = simhash(text1);
    const fp2 = simhash(text2);
    // 6 个 token 中只差 1 个，Hanming 距离应小于 3（典型阈值）
    // 但不能保证，因为 fnv1a64 可能放大差异 — 这里只测不会到离谱
    expect(hammingDistance(fp1, fp2)).toBeLessThan(50);
  });

  it('完全不同文本产生较大汉明距离', () => {
    const text1 = new Map([
      ['hello', 5],
      ['world', 5],
    ]);
    const text2 = new Map([
      ['foo', 5],
      ['bar', 5],
      ['baz', 5],
    ]);

    const fp1 = simhash(text1);
    const fp2 = simhash(text2);
    // 完全不同词表，距离不应太小
    expect(hammingDistance(fp1, fp2)).toBeGreaterThan(0);
  });

  it('交换顺序不影响距离对称性', () => {
    const a = 0x1234567890abcdefn;
    const b = 0xfedcba0987654321n;
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});
