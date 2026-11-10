/**
 * scripts/test-card-parse.mjs —— 预约卡片直读解析的离线测试
 * 用法：node scripts/test-card-parse.mjs
 */
import { parseLiveCard, extractCardReserve, parseCardTime, parseReserveDescTime } from '../lib/duty-card.mjs'

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

// 7) 新版预约卡：additional.type=ADDITIONAL_TYPE_RESERVE（desc1.text 才是时间）
const fixedNow = bj('2026-11-10 12:00')
ok('desc 时间 11-17 11:00', parseReserveDescTime('11-17 11:00 直播', fixedNow), bj('2026-11-17 11:00'))
ok('desc 时间 11月15日 11:00', parseReserveDescTime('11月15日 11:00', fixedNow), bj('2026-11-15 11:00'))
ok('desc 时间 11/17 11:00', parseReserveDescTime('11/17 11:00', fixedNow), bj('2026-11-17 11:00'))
ok('desc 时间 今天/明天', [parseReserveDescTime('今天 20:00', fixedNow), parseReserveDescTime('明天 19:30', fixedNow)], [bj('2026-11-10 20:00'), bj('2026-11-11 19:30')])
ok('desc 跨年 01-05', parseReserveDescTime('01-05 11:00', fixedNow), bj('2027-01-05 11:00'))
ok('desc 无时间 NaN', Number.isNaN(parseReserveDescTime('预约中', fixedNow)), true)

const dyn2 = {
  id_str: '2', type: 'DYNAMIC_TYPE_FORWARD',
  modules: { module_dynamic: { desc: { text: '转发动态' }, additional: null }, module_author: { name: '我', mid: 23209281 } },
  orig: {
    type: 'DYNAMIC_TYPE_DRAW',
    modules: {
      module_author: { name: '嘉然今天吃什么', mid: 672328094 },
      module_dynamic: {
        major: { type: 'MAJOR_TYPE_OPUS' },
        additional: { type: 'ADDITIONAL_TYPE_RESERVE', reserve: { title: '直播预约：【突击】鸣潮3.8！', desc1: { text: '11-17 11:00 直播' }, desc2: { text: '2289人预约' }, rid: 5867427, up_mid: '672328094', reserve_total: 2289 } },
      },
    },
  },
}
const ex2 = extractCardReserve(dyn2)
ok('新版预约卡抽取', { mid: ex2.mid, name: ex2.name, title: ex2.title, at: ex2.at, side: ex2.side, cardType: ex2.cardType }, {
  mid: '672328094', name: '嘉然今天吃什么', title: '直播预约：【突击】鸣潮3.8！', at: new Date(bj('2026-11-17 11:00')).toISOString(), side: 'orig', cardType: 'additional_reserve',
})

const dyn3 = {
  id_str: '3', type: 'DYNAMIC_TYPE_FORWARD',
  modules: { module_dynamic: {}, module_author: { name: '我', mid: 23209281 } },
  orig: {
    modules: {
      module_author: { name: '乃琳Queen', mid: 672342685 },
      module_dynamic: { additional: { type: 'ADDITIONAL_TYPE_RESERVE', reserve: { title: '直播预约：【突击】鸣潮3.8主线！', desc1: { text: '11-15 11:00 直播' }, up_mid: '672342685', rid: 5869258 } } },
    },
  },
}
const ex3 = extractCardReserve(dyn3)
ok('新版预约卡（无 desc2/status）', { mid: ex3.mid, at: ex3.at, cardType: ex3.cardType }, { mid: '672342685', at: new Date(bj('2026-11-15 11:00')).toISOString(), cardType: 'additional_reserve' })

const failed = cases.filter((c) => !c.pass)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
process.exit(failed.length ? 1 : 0)
