/**
 * crypto-store 加密存储测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptApiKey,
  decryptApiKey,
  isEncrypted,
  __setTestFingerprint,
} from '../src/utils/crypto-store';

describe('crypto-store', () => {
  beforeEach(() => {
    __setTestFingerprint('test-machine:test-host:test-user');
  });

  describe('encryptApiKey / decryptApiKey', () => {
    it('加密→解密应得到原始明文', () => {
      const original = 'sk-test-api-key-12345';
      const encrypted = encryptApiKey(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted.startsWith('enc:v1:')).toBe(true);

      const decrypted = decryptApiKey(encrypted);
      expect(decrypted).toBe(original);
    });

    it('空字符串直接返回空', () => {
      expect(encryptApiKey('')).toBe('');
    });

    it('相同明文每次加密产生不同密文（IV 随机）', () => {
      const plain = 'sk-abc';
      const a = encryptApiKey(plain);
      const b = encryptApiKey(plain);
      expect(a).not.toBe(b);
      // 但都能解密回原文
      expect(decryptApiKey(a)).toBe(plain);
      expect(decryptApiKey(b)).toBe(plain);
    });

    it('加密后的密文包含特殊字符也可解密', () => {
      const special = 'sk-!@#$%^&*()_+测试中文';
      const encrypted = encryptApiKey(special);
      expect(decryptApiKey(encrypted)).toBe(special);
    });
  });

  describe('兼容性', () => {
    it('旧明文格式当明文返回', () => {
      const legacy = 'sk-old-plaintext-key';
      expect(decryptApiKey(legacy)).toBe(legacy);
    });

    it('undefined / null 返回 null', () => {
      expect(decryptApiKey(undefined)).toBeNull();
      expect(decryptApiKey(null)).toBeNull();
    });

    it('不同指纹无法解密', () => {
      const encrypted = encryptApiKey('sk-secret');

      // 换一台机器的指纹
      __setTestFingerprint('other-machine:other-host:other-user');
      expect(decryptApiKey(encrypted)).toBeNull();
    });

    it('篡改密文返回 null', () => {
      const encrypted = encryptApiKey('sk-secret');
      const tampered = encrypted.slice(0, -5) + 'xxxxx';
      expect(decryptApiKey(tampered)).toBeNull();
    });
  });

  describe('isEncrypted', () => {
    it('加密格式识别为 true', () => {
      const encrypted = encryptApiKey('sk-test');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('明文格式识别为 false', () => {
      expect(isEncrypted('sk-plain')).toBe(false);
    });

    it('空值识别为 false', () => {
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(null)).toBe(false);
    });
  });
});
