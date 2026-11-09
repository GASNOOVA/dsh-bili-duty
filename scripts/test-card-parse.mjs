/**
 * scripts/test-card-parse.mjs —— 预约卡片直读解析的离线测试
 * 用法：node scripts/test-card-parse.mjs
 */
import { parseLiveCard, extractCardReserve, parseCardTime } from '../lib/duty-card.mjs'

const bj = (s) => Date.parse(s + '+08:00')
const cases = []
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  cases.push({ label, pass, got, want })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n  got=${JSON.stringify(got)}\n  want=${JSON.stringify(want)}`}`)
}

// 1) 常见 live_play_info 结构（秒）
ok('live_play_info 秒', parseLiveCard({ type: 0, live_play_info: { room_id: 22637261, uid: 672328094, uname: '嘉然今天吃什么', title: '生日会', live_start_time: bj('2026-11-10 20:00') / 1000 } }), {
  mid: '672328094', name: '嘉然今天吃什么', title: '生日会', roomId: '22637261',
  atMs: bj('2026-11-10 20:00'), at: new Date(bj('2026-11-10 20:00')).toISOString(), cardType: '',
})

// 2) content 是 JSON 字符串 + 嵌套一层
ok('JSON 字符串+嵌套', parseLiveCard(JSON.stringify({ data: { card: { up_id: 672342685, up_name: '乃琳Queen', title: '电台回', start_time: bj('2026-11-12 19:30') / 1000 } } })), {
  mid: '672342685', name: '乃琳Queen', title: '电台回', roomId: '',
  atMs: bj('2026-11-12 19:30'), at: new Date(bj('2026-11-12 19:30')).toISOString(), cardType: '',
})

// 3) 时间字符串 "YYYY-MM-DD HH:mm:ss"（按北京时间）
ok('时间字符串', parseLiveCard({ reserve_info: { anchor_uid: 672353429, anchor_name: '贝拉kira', live_title: '深空当铺', plan_time: '2026-11-17 12:00:00' } }), {
  mid: '672353429', name: '贝拉kira', title: '深空当铺', roomId: '',
  atMs: bj('2026-11-17 12:00'), at: new Date(bj('2026-11-17 12:00')).toISOString(), cardType: '',
})

// 4) 毫秒时间戳
ok('毫秒时间戳', parseLiveCard({ live: { mid: '3537115310721181', user_name: '心宜不是心仪', name: '周五杂谈', start_ts: bj('2026-11-13 21:00') } }), {
  mid: '3537115310721181', name: '心宜不是心仪', title: '周五杂谈', roomId: '',
  atMs: bj('2026-11-13 21:00'), at: new Date(bj('2026-11-13 21:00')).toISOString(), cardType: '',
})

// 5) 脏输入
ok('垃圾输入 null', parseLiveCard('not json'), null)
ok('空洞 null', parseLiveCard({}), null)
ok('坏时间 null', parseLiveCard({ live_play_info: { uid: 1, uname: 'x', start_time: 'abc' } }), null)
ok('parseCardTime 秒/毫秒/字符串', [parseCardTime(1762776000), parseCardTime(1762776000000), parseCardTime('2026-11-10 20:00')], [1762776000000, 1762776000000, bj('2026-11-10 20:00')])

// 6) 从动态 item（含转发 orig）抽取
const dyn = {
  id_str: '1', type: 'DYNAMIC_TYPE_FORWARD',
  modules: { module_dynamic: { desc: { text: '转发动态' } }, module_author: { name: '我' } },
  orig: {
    type: 'DYNAMIC_TYPE_LIVE_RCMD',
    modules: {
      module_author: { name: '贝拉kira' },
      module_dynamic: { major: { type: 'MAJOR_TYPE_LIVE_RCMD', live_rcmd: { type: 0, content: JSON.stringify({ live_play_info: { uid: 672353429, uname: '贝拉kira', title: '水商生活', live_start_time: bj('2026-11-17 12:00') / 1000 } }) } } },
    },
  },
}
const ex = extractCardReserve(dyn)
ok('转发动态卡片抽取', { mid: ex.mid, name: ex.name, title: ex.title, at: ex.at, side: ex.side, cardType: ex.cardType }, {
  mid: '672353429', name: '贝拉kira', title: '水商生活', at: new Date(bj('2026-11-17 12:00')).toISOString(), side: 'orig', cardType: 'live_rcmd',
})

const failed = cases.filter((c) => !c.pass)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
process.exit(failed.length ? 1 : 0)
