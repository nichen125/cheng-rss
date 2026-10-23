#!/usr/bin/env node
// 最小断言框架。所有 verify 脚本共用，保持零依赖。
//
// 设计原则（PLAN §19.1）：
//   - 只做断言，不做修复
//   - 检查产物，不检查"代码里有没有某函数"
//   - 输出可机读的 PASS/FAIL 汇总，退出码非零即失败

const results = [];
let currentGroup = null;

export function group(name) {
  currentGroup = name;
  if (process.stdout.isTTY) process.stdout.write(`\n${name}\n`);
}

export function check(desc, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    if (r === true || r === undefined) {
      ok = true;
    } else if (r && typeof r === 'object') {
      ok = Boolean(r.ok);
      detail = r.detail ?? '';
    } else {
      ok = Boolean(r);
    }
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  results.push({ group: currentGroup, desc, ok, detail });
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  process.stdout.write(`  ${mark}  ${desc}${detail && !ok ? `\n        ${detail}` : ''}\n`);
  return ok;
}

// 断言辅助：失败时给出实际值，便于定位
export function eq(actual, expected, label = '') {
  return {
    ok: Object.is(actual, expected),
    detail: `${label}${label ? ': ' : ''}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  };
}

export function gt(actual, threshold, label = '') {
  return {
    ok: actual > threshold,
    detail: `${label}${label ? ': ' : ''}期望 > ${threshold}，实际 ${actual}`,
  };
}

export function lt(actual, threshold, label = '') {
  return {
    ok: actual < threshold,
    detail: `${label}${label ? ': ' : ''}期望 < ${threshold}，实际 ${actual}`,
  };
}

export function ok(cond, detail = '') {
  return { ok: Boolean(cond), detail };
}

export function summary(stepName) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const total = results.length;

  process.stdout.write('\n');
  if (fail === 0 && total > 0) {
    process.stdout.write(`\u001b[32m${stepName}: ${pass}/${total} PASS\u001b[0m\n`);
  } else if (total === 0) {
    process.stdout.write(`\u001b[33m${stepName}: 无断言（脚本无效）\u001b[0m\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`\u001b[31m${stepName}: ${pass}/${total} PASS, ${fail} FAIL\u001b[0m\n`);
    for (const r of results.filter((x) => !x.ok)) {
      process.stdout.write(`  - ${r.desc}${r.detail ? `\n    ${r.detail}` : ''}\n`);
    }
    process.exitCode = 1;
  }
  return fail === 0;
}
