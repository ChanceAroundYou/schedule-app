import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays, addMonths, diffDays, emptyRepeat, fmtDuration, iso, minToTime, monthMatrix,
  monthStart, parseIso, relLabel, repeatLabel, shortLoad, timeToMin, toRepeat, weekStart,
} from './date.ts'

test('iso / parseIso 往返一致', () => {
  const d = new Date(2026, 9, 5)
  assert.equal(iso(d), '2026-10-05')
  const back = parseIso('2026-10-05')
  assert.equal(back.getFullYear(), 2026)
  assert.equal(back.getMonth(), 9)
  assert.equal(back.getDate(), 5)
})

test('addDays 跨月跨年', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29') // 闰年
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('addMonths 钳到目标月最后一天', () => {
  // 1月31日 +1 个月应该是 2月28日，不是 3月3日
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31')
  assert.equal(addMonths('2026-03-15', -1), '2026-02-15')
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29') // 闰年 2 月
})

test('diffDays 双向', () => {
  assert.equal(diffDays('2026-10-06', '2026-10-05'), 1)
  assert.equal(diffDays('2026-10-05', '2026-10-06'), -1)
  assert.equal(diffDays('2026-10-05', '2026-10-05'), 0)
})

test('weekStart 以周一为起点', () => {
  // 2026-10-05 是周一
  assert.equal(weekStart('2026-10-05'), '2026-10-05')
  assert.equal(weekStart('2026-10-11'), '2026-10-05') // 周日归上一个周一
  assert.equal(weekStart('2026-10-07'), '2026-10-05') // 周三
})

test('monthStart 与 monthMatrix 凑满 42 天', () => {
  assert.equal(monthStart('2026-10-17'), '2026-10-01')
  const grid = monthMatrix('2026-10-17')
  assert.equal(grid.length, 42)
  assert.equal(grid[0], '2026-09-28')   // 10月1日是周四，往前推到周一
  assert.equal(grid[41], '2026-11-08')
  // 42 天连续无缺口
  for (let i = 1; i < 42; i++) {
    assert.equal(diffDays(grid[i]!, grid[i - 1]!), 1)
  }
})

test('timeToMin / minToTime 往返', () => {
  assert.equal(timeToMin('09:30'), 570)
  assert.equal(timeToMin(null), null)
  assert.equal(minToTime(570), '09:30')
  assert.equal(minToTime(0), '00:00')
  assert.equal(minToTime(1439), '23:59')
  // 越界要钳住，不能产生 24:00 这种非法值
  assert.equal(minToTime(1500), '23:59')
  assert.equal(minToTime(-10), '00:00')
})

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '')
  assert.equal(fmtDuration(45), '45分钟')
  assert.equal(fmtDuration(60), '1小时')
  assert.equal(fmtDuration(90), '1小时30分')
  assert.equal(fmtDuration(120), '2小时')
})

test('shortLoad 压成一行', () => {
  // 月视图格子很窄，「3小时45分」会折成三行把日期挤扁
  assert.equal(shortLoad(0), '')
  assert.equal(shortLoad(45), '45分')
  assert.equal(shortLoad(60), '1时')
  assert.equal(shortLoad(225), '3¾')
  assert.equal(shortLoad(90), '1½')
  assert.equal(shortLoad(135), '2¼')
  // 这些结果里不能出现「小时」以外的换行符
  for (const m of [15, 45, 60, 90, 135, 225, 300]) {
    assert.ok(!shortLoad(m).includes('\n'), 'shortLoad 不应含换行')
    assert.ok(shortLoad(m).length <= 4, 'shortLoad 应足够短')
  }
})

test('relLabel 相对说法', () => {
  const t = iso(new Date())
  assert.equal(relLabel(t), '今天')
  assert.equal(relLabel(addDays(t, 1)), '明天')
  assert.equal(relLabel(addDays(t, 2)), '后天')
  assert.equal(relLabel(addDays(t, -1)), '昨天')
  assert.equal(relLabel(addDays(t, -3)), '逾期 3 天')
})

test('toRepeat 升级旧的字符串写法', () => {
  const r1 = toRepeat('daily', '2026-10-05')
  assert.equal(r1.unit, 'day')
  const r2 = toRepeat('weekly', '2026-10-05') // 2026-10-05 是周一
  assert.equal(r2.unit, 'week')
  assert.deepEqual(r2.weekdays, [1])
  const r3 = toRepeat({ unit: 'month', n: 2, monthday: 15, weekdays: [], end: null }, '2026-10-05')
  assert.equal(r3.unit, 'month')
  assert.equal(r3.n, 2)
  assert.equal(r3.monthday, 15)
  // null / undefined 给默认
  assert.equal(toRepeat(null, '2026-10-05').unit, 'none')
  assert.equal(toRepeat(undefined).unit, 'none')
})

test('emptyRepeat 的 monthday 取自给定日期', () => {
  assert.equal(emptyRepeat('2026-10-17').monthday, 17)
  assert.equal(emptyRepeat(null).monthday > 0, true)
})

test('repeatLabel 文案', () => {
  assert.equal(repeatLabel(null), '')
  assert.equal(repeatLabel(toRepeat('daily')), '每天')
  assert.equal(repeatLabel({ unit: 'week', n: 1, weekdays: [1, 3], monthday: 1, end: null }), '每周一、三')
  assert.equal(repeatLabel({ unit: 'week', n: 2, weekdays: [], monthday: 1, end: null }), '每 2 周')
  assert.equal(repeatLabel({ unit: 'month', n: 1, weekdays: [], monthday: 15, end: null }), '每月 15 号')
  assert.equal(repeatLabel({ unit: 'year', n: 1, weekdays: [], monthday: 1, end: null }), '每年')
})
