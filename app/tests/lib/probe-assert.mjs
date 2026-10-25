// app/tests/lib/probe-assert.mjs —— 探针断言计数器
export let failures = 0;
export function ok(cond, what, detail) {
  const tail = detail === undefined || detail === '' ? '' : '（' + detail + '）';
  if (cond) console.log('  ok  ', what, tail);
  else { failures++; console.log('  FAIL', what, tail); }
}
export function reset() { failures = 0; }
