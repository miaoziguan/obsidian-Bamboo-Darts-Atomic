/**
 * API Key 本地加密存储
 *
 * 使用 AES-256-GCM + 机器指纹派生密钥，避免 data.json 中明文泄露。
 * 加密后的 Key 可随 Obsidian Sync / iCloud / Git 同步，但只有同机器/同用户能解密。
 *
 * 格式：enc:v1:{base64iv}:{base64ciphertext}:{base64authtag}
 * 兼容旧版明文格式：不以 "enc:" 开头 → 当明文返回，由调用方负责升级。
 */

import * as crypto from 'crypto';
import * as os from 'os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';
const PREFIX = `enc:${VERSION}:`;

// ─── 密钥派生 ───

/** 测试用：设置固定指纹替代系统采集 */
let _testFingerprint: string | null = null;

/** 暴露测试接口，勿在生产代码中调用 */
export function __setTestFingerprint(fp: string | null): void {
  _testFingerprint = fp;
}

function getFingerprint(): string {
  if (_testFingerprint !== null) return _testFingerprint;
  try {
    return `${process.platform}:${os.hostname()}:${os.userInfo().username}`;
  } catch {
    // 极端情况（如浏览器环境无 process/os）→ 用空字符串做兜底密钥
    return 'bamboo-darts-fallback-v1';
  }
}

function getDerivedKey(): Buffer {
  return crypto.createHash('sha256').update(getFingerprint()).digest();
}

// ─── 加密 / 解密 ───

/** 加密 API Key，返回存储格式字符串 */
export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return plaintext;

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return `${PREFIX}${iv.toString('base64')}:${encrypted}:${authTag}`;
}

/**
 * 解密 API Key
 * @returns 明文 Key，失败返回 null（需用户重新输入）
 */
export function decryptApiKey(stored: string | undefined | null): string | null {
  if (!stored) return null;

  // 旧明文格式 → 当明文返回，外部升级
  if (!stored.startsWith('enc:')) return stored;

  const rest = stored.slice(4); // 去掉 "enc:"
  const sep1 = rest.indexOf(':');
  if (sep1 === -1) return null;
  const version = rest.slice(0, sep1);
  if (version !== VERSION) return null;

  const payload = rest.slice(sep1 + 1);
  const parts = payload.split(':');
  if (parts.length !== 3) return null;

  const [ivB64, encrypted, authTagB64] = parts;

  try {
    const key = getDerivedKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

/** 判断存储值是否已加密 */
export function isEncrypted(stored: string | undefined | null): boolean {
  return !!stored && stored.startsWith('enc:');
}
