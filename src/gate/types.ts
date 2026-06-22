/**
 * 门控规则类型定义
 */

export type GateResult =
  | { status: 'ok' }
  | { status: 'warn'; reason: string }
  | { status: 'block'; reason: string };

export interface GateCheckResult {
  passed: boolean;
  summary: string;
  reasons: string[];
  warnings: string[];
}

function ok(): GateResult {
  return { status: 'ok' };
}

function warn(reason: string): GateResult {
  return { status: 'warn', reason };
}

function block(reason: string): GateResult {
  return { status: 'block', reason };
}
