/**
 * Bamboo Darts 自定义错误类型
 * 用于在调用链中精确区分取消、超时等语义，替代字符串匹配
 */

/** 用户主动取消提炼 */
export class CancellationError extends Error {
  constructor(message = '提炼已取消') {
    super(message);
    this.name = 'CancellationError';
  }
}
