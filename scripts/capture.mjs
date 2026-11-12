#!/usr/bin/env node
/**
 * 用 Playwright 截一张操作台的图，顺便当成 UI 冒烟测试：任何 page error 都会让脚本失败。
 *
 *   npm run serve                 # 终端 A（默认 8787）
 *   npx playwright install chromium
 *   node scripts/capture.mjs      # 终端 B
 *
 * Playwright 刻意不进 devDependencies：它有一百多兆的浏览器，只为了截图不值得塞进
 * 「零运行时依赖」的仓库。需要时按提示临时装即可。
 */

const PORT = process.env.PORT ?? '8787'
const BASE = `http://localhost:${PORT}`
const OUT = new URL('../docs/console.png', import.meta.url).pathname

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('缺少 playwright。先执行：npm i --no-save playwright && npx playwright install chromium')
  process.exit(1)
}

const api = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} → ${response.status}`)
  return response.json()
}

/** 造一份能覆盖全部差异类型的示例数据。 */
async function seed() {
  const stamp = Date.now().toString(36).toUpperCase()
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  await api('/funding', { amount: 500_000 })
  for (let i = 1; i <= 3; i += 1) {
    const transferId = `TX-${day}-0${i}`
    await api('/transfers', {
      transferId,
      amount: 12_000 + i * 3_000,
      fee: 72 + i * 18,
      idempotencyKey: `seed-${stamp}-${i}`,
    })
    await api(`/transfers/${transferId}/settle`, {})
  }
  return { stamp, day }
}

const { stamp, day } = await seed()

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1240 }, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

const pay = async (transferId, amount, fee, key) => {
  await page.click('.tabs button[data-act="pay"]')
  await page.fill('#amount', amount)
  await page.fill('#fee', fee)
  await page.fill('#ref', transferId)
  if (key) await page.fill('#key', key)
  await page.click('#submit')
  await page.waitForSelector('#receipt.show')
  await page.waitForTimeout(250)
}

const settle = async (transferId) => {
  await page.click('.tabs button[data-act="settle"]')
  await page.fill('#ref', transferId)
  await page.click('#submit')
  await page.waitForTimeout(250)
}

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('#accounts tr td.code')

// 一笔支付 + 结算，让出款流水有当天的数据
await pay(`TX-${day}-04`, '188.00', '1.13', `shot-${stamp}-1`)
await settle(`TX-${day}-04`)

await page.click('#recon-btn')
await page.waitForSelector('.bucket .n')
await page.waitForTimeout(300)

// 收尾：打一单再重发，让票据留下 REPLAYED 章（截图的主角）
await pay(`TX-${day}-07`, '92.50', '0.56', `shot-${stamp}-2`)
await page.click('#replay')
await page.waitForSelector('.replayed-stamp')
await page.waitForTimeout(400)

const size = await page.evaluate(() => {
  const main = document.querySelector('main').getBoundingClientRect()
  return { width: Math.ceil(document.documentElement.clientWidth), height: Math.ceil(main.bottom + 40) }
})
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: size.width, height: size.height } })

const buckets = await page.$$eval('.bucket', (els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')))
const trial = (await page.textContent('#t-balance')).trim()

await browser.close()

console.log('截图：', OUT, `${size.width}x${size.height}`)
console.log('对账分桶：', buckets.join(' | '))
console.log('试算：', trial)

if (errors.length > 0) {
  console.error('页面报错：', errors)
  process.exit(1)
}
if (trial !== '借贷平衡') {
  console.error('试算不平衡，截图不可用')
  process.exit(1)
}
console.log('UI 冒烟通过：无页面报错，借贷平衡，重发出现 REPLAYED 章')
