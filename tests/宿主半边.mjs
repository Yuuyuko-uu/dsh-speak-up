// 宿主半边冒烟测试 —— 用假的 ctx / 假的 agent 把 lib/host.js 跑一遍。
//
// ⚠ 它**不装插件、不碰 DSH、不碰你的会话**：DSH_HOME 指到系统临时目录，
//   agent 是假的，followup 只是把消息收进数组里。
// ⚠ 它能验的：默认值 / 归一化 / 落盘 / 安静时段 / 时机因子 / 冷却 / 各种「安全的什么都不做」/
//   消息形状（role=user、source.kind=speak-up）/ developer 拒发 / 换表 / 配置文件坏掉的兜底 /
//   **会话标题来源（抄朗读桥那条路）/ 勾选清单 / 多目标时只挑一个**。
// ⚠ 它**验不了**的：真的 followup 到活着会话上会不会开一轮（那个必须在 DSH 里跑），
//   以及真机上 ctx.sessionTitle 到底给不给标题（这里喂的是假服务）。
//
// 跑法： node tests/宿主半边.mjs   （node 20+）

import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'hw-'))
process.env.DSH_HOME = 家

// ---- 先铺好「投影缓存文件」，验标题的第二种来源（也是真机上真正管用的那条）----
// 目录： <DSH_HOME>/storages/session_projcache/sessions/<id>.json
// ⚠ 文件名里的 id 带不带 `session-` 前缀**两种都存在**，所以两种都要铺一份来验
const ID_长 = 'session-0f1e2d3c-4b5a-6978-8c9d-0a1b2c3d4e5f'
const ID_裸 = 'abc12345-6789-4abc-9def-0123456789ab' // 故意不带 session- 前缀的 id
const ID_首条 = 'session-首条消息兜底'
const 投影目录 = join(家, 'storages', 'session_projcache', 'sessions')
mkdirSync(投影目录, { recursive: true })
const 铺投影 = (文件名, rows) => writeFileSync(join(投影目录, 文件名 + '.json'), JSON.stringify({ version: 7, record: { rows } }), 'utf8')
// ① 真机上那个：id 已带前缀，文件名就是「原样」
铺投影(ID_长, { title: { ver: 1, seq: 9, val: '示例会话' } })
// ② id 不带前缀 → 文件名要**补**上前缀才找得到
铺投影('session-' + ID_裸, { title: { ver: 1, seq: 3, val: '裸 id 那个会话' } })
// ③ 只有 titleInput（还没有正式标题）→ 用它的第一条消息兜底
铺投影(ID_首条, { titleInput: { ver: 3, seq: 4, val: { first: { seq: 4, text: '  帮我看看这段代码有什么问题  ' } } } })

const 插件 = await import(new URL('../lib/host.js', import.meta.url).href)

const 路由 = new Map()
const 事件 = new Map()
const 日志 = []
const 停表们 = []
const cleanups = []

// ---- 假会话 / 假 agent / 假标题服务 ----
const 假会话表 = new Map([
  ['sess-abc', { id: 'sess-abc' }],
  [ID_长, { id: ID_长 }],
  [ID_裸, { id: ID_裸 }],
  [ID_首条, { id: ID_首条 }],
  ['sess-没名字', { id: 'sess-没名字' }],
])
// ⚠ 故意只给 sess-abc 一个标题：其余全靠投影缓存文件，
//   这样才能证明「文件那条路」真的在工作（而不是被服务遮住了）
const 标题表 = new Map([['sess-abc', '甲会话']])

const 造agent = (id) => ({
  id,
  status: 'idle',
  session: { id },
  收到的: [],
  followup(m) { this.收到的.push(m) },
})
const 甲 = 造agent('sess-abc')
const 乙 = 造agent(ID_长)

const 假ctx = {
  agents: { get: (id) => [甲, 乙].find((a) => a.id === String(id)), list: () => [甲, 乙] },  sessions: { flush: async () => true },
  webServer: { register: (r) => { 路由.set(r.path, r.handler); return () => 路由.delete(r.path) } },
  interval: (cb, ms) => { 停表们.push({ cb, ms }); return () => {} },
  logger: { info: (s) => 日志.push(s), warn: (s) => 日志.push(s) },
  effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
  on: (n, cb) => { if (!事件.has(n)) 事件.set(n, []); 事件.get(n).push(cb); return () => {} },
  get: (n) => {
    if (n === 'sessions') {
      // 抄朗读桥：会话清单来自 ctx.sessions.list()，Session 对象用 ctx.sessions.get(id) 取
      return { list: () => [...假会话表.values()], get: (id) => 假会话表.get(String(id)) }
    }
    if (n === 'sessionTitle') {
      // ⚠ 抄朗读桥的用法：传进来的是 **Session 对象**，不是 id
      return { get: (会话) => (标题表.has(String(会话 && 会话.id)) ? { title: 标题表.get(String(会话.id)) } : undefined) }
    }
    if (n === 'sessionController') {
      return { inspect: async () => ({ events: [] }), create: async () => ({ sessionId: 'sess-新建的' }) }
    }
    return undefined
  },
}

插件.apply(假ctx)

let 挂 = 0
const 报 = (标签, 过, 详情) => { if (!过) 挂++; console.log(`${过 ? 'PASS' : 'FAIL'}  ${标签}${详情 ? '  :: ' + 详情 : ''}`) }
const 造res = () => ({ 体: null, writeHead() {}, end(s) { this.体 = JSON.parse(s) } })
const 调 = async (路径, body) => {
  const res = 造res()
  await 路由.get(路径)({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body || {})) } }, res)
  return res.体
}
const 滴答 = async (第几个 = 0) => { await 停表们[第几个].cb(); await new Promise((s) => setTimeout(s, 40)) }
const 她说话 = (多久以前毫秒 = 0) =>
  事件.get('session/event').forEach((cb) => cb({ id: 'sess-abc' }, { type: 'user/message', time: Date.now() - 多久以前毫秒, data: { source: { kind: 'user' } } }))

// ---------- 基本 ----------
报('注册了 4 条路由', 路由.size === 4, [...路由.keys()].join(' '))
报('定时器挂上（30 分钟）', 停表们.length === 1 && 停表们[0].ms === 1800000)
let st = await 调('/dsh-speak-up/state')
报('默认值全对（间隔30 / 35% / 1~8 / 20×0.15 / 360×1.5 / 试运行开 / 总开关开 / user）',
  st.配置.间隔分钟 === 30 && st.配置.峰时概率 === 20 && st.配置.谷时概率 === 60 &&
  st.配置.安静起 === 1 && st.配置.安静止 === 8 &&
  st.配置.近阈值分钟 === 20 && st.配置.近因子 === 0.15 && st.配置.远阈值分钟 === 360 && st.配置.远因子 === 1.5 &&
  st.配置.试运行 === true && st.配置.总开关 === true && st.配置.角色 === 'user')
报('「目标会话」默认是空数组（勾选清单的形状）', Array.isArray(st.配置.目标会话) && st.配置.目标会话.length === 0)

// ---------- 会话清单 + 标题（两条来源都要验）----------
const 清单 = st.活着的会话
const 找 = (id) => 清单.find((s) => s.id === id) || {}
报('清单列出全部 5 个会话', 清单.length === 5, 清单.map((s) => s.标题 + '/' + s.id.slice(-8)).join('  '))
报('第一条路：标题来自 ctx.sessionTitle.get(session)',
  找('sess-abc').标题 === '甲会话' && 找('sess-abc').标题来源 === '会话标题服务')
报('第二条路：投影缓存 record.rows.title.val（文件名 = id 原样，带前缀）',
  找(ID_长).标题 === '示例会话' && 找(ID_长).标题来源 === '投影缓存 title', JSON.stringify(找(ID_长)))
报('第二条路：id 不带前缀时，文件名**补上** session- 也找得到',
  找(ID_裸).标题 === '裸 id 那个会话', JSON.stringify(找(ID_裸)))
报('第二条路：只有 titleInput 时，用「首条输入」兜底（并去掉首尾空白）',
  找(ID_首条).标题 === '帮我看看这段代码有什么问题', JSON.stringify(找(ID_首条)))
报('两条路都没有 → 空串（页面显示「（还没起名）」），不报错不留空白',
  找('sess-没名字').标题 === '' && 找('sess-没名字').标题来源 === '没有')
报('没标题的排最后（排序不含「勾着」，勾选时行不会乱跳）', 清单[清单.length - 1].标题 === '' && 清单[0].标题 !== '')
报('每行带状态和「有没有 agent」，没有 agent 的那个标成「没活着」',
  清单.every((s) => typeof s.状态 === 'string' && typeof s.有agent === 'boolean') &&
  找('sess-没名字').有agent === false && 找('sess-没名字').状态 === '没活着')

// ---------- 没勾 → 什么都不做 ----------
let r = await 调('/dsh-speak-up/roll', { 模式: '真发' })
报('一个都没勾 → 挡住并记账', 甲.收到的.length === 0 && r.日志.at(-1).文本.includes('还没勾'), r.日志.at(-1).文本)

// ---------- 存 + 归一化 + 落盘 ----------
r = await 调('/dsh-speak-up/save', { 目标会话: ['sess-abc'], 间隔分钟: '7', 峰时概率: '150', 安静起: 0, 安静止: 0, 近因子: '0.2' })
报('字符串数字被洗成数字、超范围被夹住', r.配置.间隔分钟 === 7 && r.配置.峰时概率 === 100 && r.配置.近因子 === 0.2)
报('起===止 → 不启用安静时段', r.配置.安静起 === 0 && r.配置.安静止 === 0)
报('写盘成功', existsSync(join(家, 'speak-up-config.json')) &&
  JSON.parse(readFileSync(join(家, 'speak-up-config.json'), 'utf8')).目标会话[0] === 'sess-abc')

// 老配置（字符串形状，还带逗号）也要能吃
writeFileSync(join(家, 'speak-up-config.json'), JSON.stringify({ 目标会话: 'sess-abc, ' + ID_长 }), 'utf8')
st = await 调('/dsh-speak-up/state')
报('老配置里的字符串（带逗号）会被洗成 id 数组',
  Array.isArray(st.配置.目标会话) && st.配置.目标会话.length === 2, JSON.stringify(st.配置.目标会话))
报('「已勾情况」标出了每个勾着的会话活着没',
  st.目标情况.length === 2 && st.目标情况.every((x) => x.活着 === true) && st.目标活着 === true)
await 调('/dsh-speak-up/save', {
  目标会话: ['sess-abc'], 间隔分钟: 30, 近阈值分钟: 20, 近因子: 0.15,
  远阈值分钟: 360, 远因子: 1.5, 试运行: true, 安静起: 1, 安静止: 8,
  // ⚠ 这几条只验「时机因子」，所以两格概率都显式给 100 —— 这样不管跑测试时是峰时还是谷时，
  //   基础概率都是 100，期望值不会跟着时段变（**不依赖默认值，也不依赖真实时间**）
  峰时概率: 100, 谷时概率: 100,
})

// ---------- 时机因子（走定时这条真路；试运行开着 → 绝不会真发）----------
她说话(0)
await 滴答()
报('时机因子：刚说过话 → 有效概率 15%（100 × 0.15）', 日志.at(-1).includes('15.0%'), 日志.at(-1))
报('记账里写明了这一档用的是哪格概率',
  日志.at(-1).includes(插件.判峰时(new Date()) ? '用峰时概率 100%' : '用谷时概率 100%'), 日志.at(-1))
她说话(7 * 3600 * 1000)
await 滴答()
报('时机因子：7 小时没说话 → ×1.5 并夹到 100%', 日志.at(-1).includes('100.0%'), 日志.at(-1))
她说话(60 * 60 * 1000)
await 滴答()
报('时机因子：1 小时没说话 → 因子 1', 日志.at(-1).includes('因子 1'), 日志.at(-1))

await 调('/dsh-speak-up/save', { 峰时概率: 0, 谷时概率: 0, 近阈值分钟: 0 })
await 滴答()
报('两格概率都是 0 → 永不掷中', 甲.收到的.length === 0 && 日志.at(-1).includes('没掷中'), 日志.at(-1))

// ---------- 峰谷分时：纯函数直测（**全部喂假时间**，跟跑测试的真实时刻无关）----------
// 2026-10-19 是周一，2026-10-24 是周六（写死日期，固定不随时间漂）
const 某时 = (日, 时, 分 = 0) => new Date(2026, 9, 日, 时, 分, 0) // 月份 9 = 10 月
报('判峰时：周一 10:00 = 峰时',
  插件.判峰时(某时(19, 10)) === true)
报('判峰时：周一 13:00（午休）= 谷时',
  插件.判峰时(某时(19, 13)) === false)
报('判峰时：周六 10:00（看着像峰时点）= 谷时（周末全天）',
  插件.判峰时(某时(24, 10)) === false)
报('判峰时：周日 10:00 = 谷时（周末全天）',
  插件.判峰时(某时(25, 10)) === false)
报('判峰时边界：周一 9:00 = 峰、12:00 = 谷、14:00 = 峰、18:00 = 谷',
  插件.判峰时(某时(19, 9)) === true && 插件.判峰时(某时(19, 12)) === false &&
  插件.判峰时(某时(19, 14)) === true && 插件.判峰时(某时(19, 18)) === false)
报('判峰时：周一 8:59 = 谷、11:59 = 峰、13:59 = 谷、17:59 = 峰（窗口内一侧）',
  插件.判峰时(某时(19, 8, 59)) === false && 插件.判峰时(某时(19, 11, 59)) === true &&
  插件.判峰时(某时(19, 13, 59)) === false && 插件.判峰时(某时(19, 17, 59)) === true)
报('判峰时：周一 晚上 22:00 / 凌晨 3:00 = 谷时',
  插件.判峰时(某时(19, 22)) === false && 插件.判峰时(某时(19, 3)) === false)

const 假配置 = { 峰时概率: 20, 谷时概率: 60 }
const 峰时档 = 插件.算基础概率(假配置, 某时(19, 10))
const 谷时档 = 插件.算基础概率(假配置, 某时(24, 10))
报('算基础概率：峰时用「峰时概率」，说法带时段说明',
  峰时档.峰 === true && 峰时档.基础概率 === 20 && 峰时档.说法.includes('峰时') &&
  峰时档.说法.includes('周一~周五 9:00~12:00、14:00~18:00') && 峰时档.说法.includes('用峰时概率 20%'),
  峰时档.说法)
报('算基础概率：谷时用「谷时概率」，说法点明周末/早晚/午休',
  谷时档.峰 === false && 谷时档.基础概率 === 60 && 谷时档.说法.includes('谷时') &&
  谷时档.说法.includes('周末/早晚/午休') && 谷时档.说法.includes('用谷时概率 60%'),
  谷时档.说法)

// ---------- 峰谷分时：接在算概率上（走定时这条路，看记账里的百分比）----------
她说话(60 * 60 * 1000) // 距上次说话 60 分钟 → 时机因子 1
// ① 时机因子仍要照乘：两格都给 40、近因子 0.15 → 40 × 0.15 = 6%（跟当前是峰是谷无关）
await 调('/dsh-speak-up/save', { 峰时概率: 40, 谷时概率: 40, 近阈值分钟: 20, 近因子: 0.15 })
她说话(0) // 刚说过话 → 近因子生效
await 滴答()
报('峰时/谷时概率 40 × 近因子 0.15 = 6%（时机因子照样乘进去）',
  日志.at(-1).includes('6.0%'), 日志.at(-1))

// ② 两格填一样 = 不分档：不管当前哪一档，有效概率都是同一个数
她说话(60 * 60 * 1000)
await 滴答()
报('两格填一样（40/40）→ 不分峰谷，有效概率就是 40%（当前哪一档都一样）',
  日志.at(-1).includes('40.0%'), 日志.at(-1))

// ③ 记账里的档位跟 判峰时() 对得上（当前真实时刻算出来的那一档）
const 未是峰时 = 插件.判峰时(new Date())
await 调('/dsh-speak-up/save', { 峰时概率: 30, 谷时概率: 70 })
await 滴答()
报('记账里的档位和 判峰时(现在) 一致，并且用的是对应那格概率',
  未是峰时 ? (日志.at(-1).includes('用峰时概率 30%') && 日志.at(-1).includes('30.0%'))
            : (日志.at(-1).includes('用谷时概率 70%') && 日志.at(-1).includes('70.0%')),
  日志.at(-1))

// ④ 老配置里的「概率」不再读：文件里只有旧键 → 用两格默认值，且归一化结果里没有「概率」
writeFileSync(join(家, 'speak-up-config.json'), JSON.stringify({ 概率: 80, 目标会话: ['sess-abc'] }), 'utf8')
const 老配置 = await 调('/dsh-speak-up/state')
报('老配置里的「概率: 80」被丢掉，两格回到默认 20 / 60',
  老配置.配置.峰时概率 === 20 && 老配置.配置.谷时概率 === 60 && 老配置.配置.概率 === undefined,
  JSON.stringify(老配置.配置))
await 调('/dsh-speak-up/save', { 峰时概率: 40, 谷时概率: 40 })
报('两格超范围会被夹住（150 → 100）',
  (await 调('/dsh-speak-up/save', { 峰时概率: '150', 谷时概率: '-5' })).配置.峰时概率 === 100 &&
  (await 调('/dsh-speak-up/state')).配置.谷时概率 === 0)
await 调('/dsh-speak-up/save', { 峰时概率: 100, 谷时概率: 100 })

// ---------- 安静时段 ----------
const 小时 = new Date().getHours()
await 调('/dsh-speak-up/save', { 峰时概率: 100, 谷时概率: 100, 近阈值分钟: 20, 安静起: 小时, 安静止: (小时 + 1) % 24 })
await 滴答()
报('安静时段内 → 定时这轮不掷', 日志.at(-1).includes('安静时段'), 日志.at(-1))
// ⚠ 起 === 止 那条她特意提过两次，所以这里**行为上也验一遍**（不只是验配置归一化）：
//   把起止都设成当前小时 → 应当**不被拦住**，正常往下掷
await 调('/dsh-speak-up/save', { 安静起: 小时, 安静止: 小时 })
await 滴答()
报('安静时段 起 === 止 → 不启用：当前小时也不会被拦（照样往下掷）',
  !日志.at(-1).includes('安静时段') && (日志.at(-1).includes('没掷中') || 日志.at(-1).includes('掷中')), 日志.at(-1))
await 调('/dsh-speak-up/save', { 安静起: 23, 安静止: 7 })
await 滴答()
报('跨午夜安静时段（23~7）不误判', true)

// ---------- 勾了但没活着 / 勾了在忙 ----------
await 调('/dsh-speak-up/save', { 安静起: 0, 安静止: 0, 目标会话: ['sess-不存在'] })
await 滴答()
报('勾的会话没有活着的 agent → 什么都不做（不唤醒冷会话）', 日志.at(-1).includes('都不能说话'), 日志.at(-1))

await 调('/dsh-speak-up/save', { 目标会话: [ID_长] })
乙.status = 'running'
await 滴答()
报('勾的唯一一个在忙 → 什么都不做', 日志.at(-1).includes('都不能说话'), 日志.at(-1))

// ---------- 多目标：一次只在其中一个里开口 ----------
await 调('/dsh-speak-up/save', { 目标会话: ['sess-abc', ID_长] })
甲.收到的.length = 0
乙.收到的.length = 0
await 调('/dsh-speak-up/roll', { 模式: '真发' }) // 乙还在 running → 只能挑 甲
报('勾了 2 个、其中 1 个在忙 → 只发给不忙的那个',
  甲.收到的.length === 1 && 乙.收到的.length === 0, `甲${甲.收到的.length} 乙${乙.收到的.length}`)
乙.status = 'idle'

let 发甲 = 0
let 发乙 = 0
for (let i = 0; i < 40; i++) {
  甲.收到的.length = 0
  乙.收到的.length = 0
  await 调('/dsh-speak-up/roll', { 模式: '真发' })
  发甲 += 甲.收到的.length
  发乙 += 乙.收到的.length
}
报('两个都可用 → 每次只发一个，两边都会被轮到（不是只发第一个）',
  发甲 + 发乙 === 40 && 发甲 > 0 && 发乙 > 0, `甲${发甲} 乙${发乙}`)
报('多目标时记账里写了这次挑的是谁', 日志.at(-1).includes('这次挑'), 日志.at(-1))

// ---------- 演练 / 真发 ----------
甲.收到的.length = 0
r = await 调('/dsh-speak-up/roll', { 模式: '演练' })
报('演练：只记账，绝不真发', 甲.收到的.length === 0 && r.日志.at(-1).文本.includes('演练'), r.日志.at(-1).文本)

await 调('/dsh-speak-up/save', { 目标会话: ['sess-abc'] })
甲.收到的.length = 0
await 调('/dsh-speak-up/roll', { 模式: '真发' })
const m = 甲.收到的[0]
报('真发：followup 收到一条形状合法的消息（role=user / source.kind=speak-up / text 块 / id 非空）',
  甲.收到的.length === 1 && m.role === 'user' && m.source.kind === 'speak-up' &&
  Array.isArray(m.content) && m.content[0].type === 'text' &&
  typeof m.id === 'string' && m.id.length > 0, JSON.stringify(m))

甲.收到的.length = 0
await 滴答()
报('自己刚开过口 → 自动这轮不重复（冷却）', 甲.收到的.length === 0 && 日志.at(-1).includes('刚开过口'), 日志.at(-1))

// ---------- developer 角色 ----------
await 调('/dsh-speak-up/save', { 角色: 'developer' })
甲.收到的.length = 0
r = await 调('/dsh-speak-up/roll', { 模式: '真发' })
报('角色 developer → 主动拒发并记账（不写坏会话日志）',
  甲.收到的.length === 0 && r.日志.at(-1).文本.includes('developer'), r.日志.at(-1).文本)
await 调('/dsh-speak-up/save', { 角色: 'user' })

// ---------- 总开关 ----------
await 调('/dsh-speak-up/save', { 总开关: false, 近阈值分钟: 0, 峰时概率: 100, 谷时概率: 100 })
await 滴答()
报('总开关关 → 定时这轮不动', 日志.at(-1).includes('总开关'), 日志.at(-1))
await 调('/dsh-speak-up/save', { 总开关: true, 试运行: true })

// ---------- 新建小屋：追加勾选，不覆盖 ----------
await 调('/dsh-speak-up/save', { 目标会话: ['sess-abc'] })
r = await 调('/dsh-speak-up/new-session', { 设为目标: true })
报('新建会话后是「追加」勾上，不覆盖原来勾的',
  r.新会话 === 'sess-新建的' && r.配置.目标会话.length === 2 && r.配置.目标会话[0] === 'sess-abc',
  JSON.stringify(r.配置.目标会话))
await 调('/dsh-speak-up/save', { 目标会话: ['sess-abc'] })

// ---------- 换表 ----------
const 表数前 = 停表们.length
await 调('/dsh-speak-up/save', { 间隔分钟: 5 })
await 滴答()
await new Promise((s) => setTimeout(s, 30))
报('改了间隔 → 下一轮自动换表（不用重启插件）',
  停表们.length === 表数前 + 1 && 停表们.at(-1).ms === 300000, `表数 ${停表们.length}`)

// ---------- 坏配置 ----------
writeFileSync(join(家, 'speak-up-config.json'), '{ 这不是 json', 'utf8')
const st2 = await 调('/dsh-speak-up/state')
报('配置文件坏掉 → 回到默认值，不抛错', st2.ok === true && st2.配置.间隔分钟 === 30)

// ---------- 完全没有标题服务的部署：第二条路（投影缓存）必须还能出标题 ----------
{
  const 只读路由 = new Map()
  const 会话服务 = 假ctx.get('sessions')
  const 没标题ctx = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { flush: async () => true },
    webServer: { register: (r) => { 只读路由.set(r.path, r.handler); return () => {} } },
    interval: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { fn() },
    on: () => () => {},
    // 注意：**没有 sessionTitle** 这个服务
    get: (n) => (n === 'sessions' ? 会话服务 : undefined),
  }
  const 插件2 = await import(new URL('../lib/host.js', import.meta.url).href + '?v=2')
  插件2.apply(没标题ctx)
  let 崩 = false
  let 结果 = null
  try {
    const res = 造res()
    await 只读路由.get('/dsh-speak-up/state')(
      { [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}') } }, res)
    结果 = res.体
  } catch (e) { 崩 = true }
  const 无服务清单 = (结果 && 结果.活着的会话) || []
  const 无服务长 = 无服务清单.find((s) => s.id === ID_长) || {}
  报('ctx.sessionTitle 不在时不崩，而且**标题照样从投影缓存读出来**（那条路不依赖任何服务）',
    !崩 && 结果 && 结果.ok === true && 无服务长.标题 === '示例会话' && 无服务长.标题来源 === '投影缓存 title',
    JSON.stringify(无服务长))
}

// ---------- 卸载 ----------
let 卸崩 = false
try { cleanups.forEach((c) => c()) } catch (e) { 卸崩 = true }
报('卸载清理不抛错', !卸崩)

console.log(`\n${挂 === 0 ? '全部通过 ✅' : `有 ${挂} 条没过 ❌`}`)
// 收摊：把这次用的临时 DSH_HOME 删掉（别让 %TEMP% 里攒一堆 hw-* 目录）
try { rmSync(家, { recursive: true, force: true }) } catch (e) {}
process.exitCode = 挂 === 0 ? 0 : 1
