// ⭐ 0.3.4（issue #12）守门测试：
//   从**局域网地址 / 反代域名**打开设置页时，POST 不能因为「只认 loopback 的名单」被 403。
//
//   两条路都要验：
//     ① 宿主有 connection.requestRejection，并且它放行 → 我们也必须放行；
//     ② 宿主没有 connection 服务 → 退回自带的「本机来源」名单（这时局域网来源仍该被拦）。
//
// 跑法：node tests/守门.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), '守门-'))
process.env.DSH_HOME = 家

const 插件 = await import(new URL('../lib/host.js', import.meta.url).href)

let 挂 = 0
const 报 = (标签, 过, 详情) => {
  if (!过) 挂++
  console.log(`${过 ? 'PASS' : 'FAIL'}  ${标签}${详情 ? '  :: ' + 详情 : ''}`)
}

const 造res = () => ({
  码: 0,
  体: null,
  原文: '',
  writeHead(c) {
    this.码 = c
  },
  end(s) {
    this.原文 = String(s == null ? '' : s)
    try {
      this.体 = JSON.parse(this.原文)
    } catch {
      this.体 = null
    }
  },
})

const 造ctx = (连接) => {
  const 路由 = new Map()
  const ctx = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { flush: async () => true },
    webServer: { register: (r) => {
      路由.set(r.path, r.handler)
      return () => 路由.delete(r.path)
    } },
    interval: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    // ⚠ 立刻执行，但**不要**顺手调用它返回的清理函数 —— 那会把刚注册的路由当场删掉
    effect: (fn) => {
      fn()
    },
    on: () => () => {},
    get: (n) => {
      if (n === 'connection') return 连接
      if (n === 'sessions') return { list: () => [], get: () => undefined }
      return undefined
    },
  }
  return { ctx, 路由 }
}

const 发POST = async (路由, 路径, 头) => {
  const res = 造res()
  const req = {
    method: 'POST',
    headers: 头,
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({}))
    },
  }
  await 路由.get(路径)(req, res)
  return res
}

const 局域网头 = { origin: 'http://192.168.5.13:3080', host: '192.168.5.13:3080' }
const 本机头 = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }

// ① 宿主有 connection 服务：它放行 → 我们也放行（LAN 来源不再被自己的名单拦）
{
  const { ctx, 路由 } = 造ctx({ requestRejection: () => undefined })
  插件.apply(ctx)
  const r1 = await 发POST(路由, '/dsh-speak-up/save', 局域网头)
  报('宿主放行时，局域网来源的 POST 不再 403', r1.码 !== 403, 'HTTP ' + r1.码 + ' ' + r1.原文.slice(0, 60))

  const r2 = await 发POST(路由, '/dsh-speak-up/save', 本机头)
  报('本机来源照旧能保存', r2.码 !== 403, 'HTTP ' + r2.码)
}

// ② 宿主**拒绝**：401/403 原样透出去
{
  const { ctx, 路由 } = 造ctx({ requestRejection: () => 403 })
  插件.apply(ctx)
  const r = await 发POST(路由, '/dsh-speak-up/save', 局域网头)
  报('宿主拒绝时，照样 403', r.码 === 403, 'HTTP ' + r.码)
}

// ③ 宿主**没有** connection 服务：退回自带名单 —— 这时局域网来源仍该被拦（兜底不能丢）
{
  const { ctx, 路由 } = 造ctx(undefined)
  插件.apply(ctx)
  const r1 = await 发POST(路由, '/dsh-speak-up/save', 局域网头)
  报('没有 connection 服务时，局域网来源仍被自带名单拦住', r1.码 === 403, 'HTTP ' + r1.码)

  const r2 = await 发POST(路由, '/dsh-speak-up/save', 本机头)
  报('没有 connection 服务时，本机来源照常放行', r2.码 !== 403, 'HTTP ' + r2.码)
}

try {
  rmSync(家, { recursive: true, force: true })
} catch {}

console.log(挂 === 0 ? '\n全部通过' : `\n${挂} 条没过`)
process.exit(挂 === 0 ? 0 : 1)
