// ============================================================================
// GLaDOS 智能签到 —— IQI 低谷探测 + 最优时机签到
// ----------------------------------------------------------------------------
// 策略：
//   1. 在可配置的探测窗口内（默认 2 小时），每隔一段时间查询 IQI
//   2. 如果 IQI < 80（Cable 加成最高档 +8），立即执行签到
//   3. 窗口结束时，在已收集的 IQI 数据中找到最低点执行签到
//   4. 如果整个窗口内 IQI 一直很高，也会在窗口结束时签到（不丢签）
//
// 环境变量（均可选，有合理默认值）：
//   SMART_PROBE_WINDOW_MIN   探测窗口总分钟数，默认 120（2 小时）
//   SMART_PROBE_INTERVAL_MIN 探测间隔分钟数，默认 10
//   SMART_IQI_THRESHOLD      IQI 低于此值立即签到，默认 80（+8 档）
//   SMART_PATIENCE_MIN       收集到低 IQI 后再等多少分钟确认是否更低，默认 15
//
// 需要的签到环境变量与 main.js 相同：GLADOS, GLADOS_UA, DOMAIN 等
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const nowBeijing = () => {
  const d = new Date(Date.now() + BEIJING_OFFSET_MS)
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' CST'
}

// ========== 配置 ==========
const PROBE_WINDOW_MIN = Number(process.env.SMART_PROBE_WINDOW_MIN) || 120
const PROBE_INTERVAL_MIN = Number(process.env.SMART_PROBE_INTERVAL_MIN) || 10
const IQI_THRESHOLD = Number(process.env.SMART_IQI_THRESHOLD) || 80
const PATIENCE_MIN = Number(process.env.SMART_PATIENCE_MIN) || 15

const PROBE_WINDOW_MS = PROBE_WINDOW_MIN * 60 * 1000
const PROBE_INTERVAL_MS = PROBE_INTERVAL_MIN * 60 * 1000
const PATIENCE_MS = PATIENCE_MIN * 60 * 1000

// ========== UA & 请求头（与 main.js 保持一致） ==========
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const detectPlatform = (ua) => {
  const s = String(ua || '')
  if (/Android/i.test(s)) return { platform: 'Android', mobile: '?1' }
  if (/iPhone|iPad|iPod/i.test(s)) return { platform: 'iOS', mobile: '?1' }
  if (/Windows/i.test(s)) return { platform: 'Windows', mobile: '?0' }
  if (/Macintosh|Mac OS X/i.test(s)) return { platform: 'macOS', mobile: '?0' }
  if (/Linux/i.test(s)) return { platform: 'Linux', mobile: '?0' }
  return { platform: 'macOS', mobile: '?0' }
}

const detectChromeMajor = (ua) => {
  const m = String(ua || '').match(/Chrome\/(\d+)/)
  return m ? m[1] : '140'
}

const buildBrowserHeaders = (ua, domain) => {
  const { platform, mobile } = detectPlatform(ua)
  const major = detectChromeMajor(ua)
  const isChromiumLike = /Chrome|Chromium|Edg\//i.test(String(ua))
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: `https://${domain}`,
    referer: `https://${domain}/console/checkin`,
    'user-agent': ua,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }
  if (isChromiumLike) {
    headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`
    headers['sec-ch-ua-mobile'] = mobile
    headers['sec-ch-ua-platform'] = `"${platform}"`
  }
  return headers
}

// ========== 获取第一个有效账号的 Cookie（用于 IQI 探测） ==========
const splitEnvLines = (value) =>
  String(value || '')
    .replace(/^["']|["']$/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const getFirstAccountCreds = () => {
  // 优先 GLADOS，再 GLADOS2...
  for (let slot = 1; slot <= 20; slot++) {
    const envName = slot === 1 ? 'GLADOS' : `GLADOS${slot}`
    const cookies = splitEnvLines(process.env[envName])
    if (!cookies.length) continue
    const cookie = cookies[0]

    // 解析 UA
    const uaCandidates =
      slot === 1 ? ['GLADOS_UA'] : [`GLADOS_UA${slot}`, `GLADOS${slot}_UA`]
    let ua = DEFAULT_UA
    for (const name of uaCandidates) {
      const lines = splitEnvLines(process.env[name])
      if (lines.length) { ua = lines[0]; break }
    }
    if (ua === DEFAULT_UA) {
      const fallback = splitEnvLines(process.env.GLADOS_UA)
      if (fallback.length) ua = fallback[0]
    }

    return { cookie, ua, envName }
  }
  return null
}

// ========== IQI 探测 ==========
const probeIQI = async (domain, headers) => {
  try {
    const res = await fetch(`https://${domain}/api/user/iqi`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    })
    const iqi = await res.json()
    if (iqi?.code === 0) {
      const score =
        iqi?.data?.quality?.score ?? iqi?.quality?.score ?? iqi?.data?.score ?? null
      const level = iqi?.data?.quality?.level || '?'
      return { score: score != null ? Number(score) : null, level, raw: iqi }
    }
    return { score: null, level: null, error: `code=${iqi?.code} ${iqi?.message || ''}` }
  } catch (err) {
    return { score: null, level: null, error: err.message }
  }
}

const cableBonus = (score) => {
  const s = Number(score)
  if (!s || s <= 0) return 0
  if (s < 80) return 8
  if (s < 85) return 5
  if (s < 90) return 3
  if (s <= 95) return 2
  return 1
}

// ========== 执行签到（调用 main.js） ==========
const runCheckin = async () => {
  const { execSync } = await import('node:child_process')
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 [${nowBeijing()}] 开始执行签到 (node main.js)`)
  console.log('='.repeat(60))
  try {
    execSync('node main.js', {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
      timeout: 5 * 60 * 1000, // 5 分钟超时
    })
    return true
  } catch (err) {
    console.error(`❌ 签到脚本执行失败: ${err.message}`)
    return false
  }
}

// ========== 主逻辑 ==========
const main = async () => {
  console.log('='.repeat(60))
  console.log('🧠 GLaDOS 智能签到 —— IQI 低谷探测模式')
  console.log('='.repeat(60))
  console.log(`⏰ 当前时间: ${nowBeijing()}`)
  console.log(`📊 探测窗口: ${PROBE_WINDOW_MIN} 分钟`)
  console.log(`🔄 探测间隔: ${PROBE_INTERVAL_MIN} 分钟`)
  console.log(`🎯 立即签到阈值: IQI < ${IQI_THRESHOLD}（Cable +${cableBonus(IQI_THRESHOLD - 1)}）`)
  console.log(`⏳ 低谷确认等待: ${PATIENCE_MIN} 分钟`)
  console.log()

  // 获取账号信息用于 IQI 探测
  const account = getFirstAccountCreds()
  if (!account) {
    console.log('⚠️  未配置任何 GLADOS 账号，直接执行签到（由 main.js 处理错误）')
    await runCheckin()
    return
  }
  console.log(`🔑 使用 ${account.envName} 的 Cookie 进行 IQI 探测`)

  const domain = process.env.DOMAIN || 'glados.cloud'
  const headers = { ...buildBrowserHeaders(account.ua, domain), cookie: account.cookie }

  // 收集 IQI 数据
  const probes = []
  const startTime = Date.now()
  const deadline = startTime + PROBE_WINDOW_MS

  // 第一次立即探测
  let bestProbe = null   // 最低 IQI 的探测结果
  let patienceDeadline = null // 发现低 IQI 后的确认截止时间

  while (true) {
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1)
    const remaining = ((deadline - Date.now()) / 60000).toFixed(1)

    console.log(`\n🔍 [${nowBeijing()}] 第 ${probes.length + 1} 次探测（已过 ${elapsed} 分钟，剩余 ${remaining} 分钟）`)

    const result = await probeIQI(domain, headers)

    if (result.score != null) {
      const bonus = cableBonus(result.score)
      probes.push({ time: Date.now(), timeStr: nowBeijing(), score: result.score, level: result.level, bonus })
      console.log(`   IQI = ${result.score} (${result.level})  →  Cable 加成 +${bonus}`)

      // 更新最低 IQI 记录
      if (!bestProbe || result.score < bestProbe.score) {
        bestProbe = { ...probes[probes.length - 1] }
        console.log(`   📉 新的最低记录！IQI = ${bestProbe.score}`)
      }

      // 立即签到条件：IQI 低于阈值（最高档 +8）
      if (result.score < IQI_THRESHOLD) {
        console.log(`\n🎯 IQI ${result.score} < ${IQI_THRESHOLD}，已达最高 Cable 加成档 +8！立即签到`)
        printProbeSummary(probes)
        await runCheckin()
        return
      }

      // 启动/更新耐心等待：发现较低 IQI 后等一会儿看是否能更低
      if (bestProbe && cableBonus(bestProbe.score) >= 5 && !patienceDeadline) {
        patienceDeadline = Date.now() + PATIENCE_MS
        console.log(`   ⏳ IQI 进入 +5 档区间，启动 ${PATIENCE_MIN} 分钟耐心等待确认低谷`)
      }
    } else {
      console.log(`   ❌ 探测失败: ${result.error}`)
      probes.push({ time: Date.now(), timeStr: nowBeijing(), score: null, error: result.error })
    }

    // 检查是否该签到了
    const now = Date.now()

    // 耐心等待到期 —— 低谷已确认
    if (patienceDeadline && now >= patienceDeadline) {
      console.log(`\n⏳ 耐心等待结束，当前最低 IQI = ${bestProbe.score} (Cable +${bestProbe.bonus})，执行签到`)
      printProbeSummary(probes)
      await runCheckin()
      return
    }

    // 探测窗口到期
    if (now >= deadline) {
      console.log(`\n⏰ 探测窗口 ${PROBE_WINDOW_MIN} 分钟已到期`)
      if (bestProbe) {
        console.log(`   窗口内最低 IQI = ${bestProbe.score} (Cable +${bestProbe.bonus})`)
      } else {
        console.log(`   ⚠️  整个窗口内未成功获取到 IQI`)
      }
      printProbeSummary(probes)
      await runCheckin()
      return
    }

    // 等待下一次探测
    const nextProbe = Math.min(
      Date.now() + PROBE_INTERVAL_MS,
      deadline,
      patienceDeadline || Infinity
    )
    const waitMs = nextProbe - Date.now()
    if (waitMs > 0) {
      console.log(`   💤 等待 ${(waitMs / 60000).toFixed(1)} 分钟后再次探测...`)
      await sleep(waitMs)
    }
  }
}

// ========== 探测汇总 ==========
const printProbeSummary = (probes) => {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`📊 IQI 探测汇总（共 ${probes.length} 次）`)
  console.log('─'.repeat(50))

  const valid = probes.filter((p) => p.score != null)
  const failed = probes.filter((p) => p.score == null)

  if (valid.length) {
    const scores = valid.map((p) => p.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)

    console.log(`  成功: ${valid.length} 次 | 失败: ${failed.length} 次`)
    console.log(`  IQI 最低: ${min} (Cable +${cableBonus(min)})`)
    console.log(`  IQI 最高: ${max} (Cable +${cableBonus(max)})`)
    console.log(`  IQI 平均: ${avg}`)
    console.log()
    console.log('  时间轴:')
    for (const p of probes) {
      if (p.score != null) {
        const bar = '█'.repeat(Math.max(1, Math.round(p.score / 5)))
        const marker = p.score === min ? ' ← 最低' : ''
        console.log(`    ${p.timeStr}  IQI=${p.score} +${p.bonus}  ${bar}${marker}`)
      } else {
        console.log(`    ${p.timeStr}  ❌ ${p.error}`)
      }
    }
  } else {
    console.log(`  ⚠️  全部 ${probes.length} 次探测均失败`)
  }
  console.log('─'.repeat(50))
}

main().catch((err) => {
  console.error(`❌ 智能签到全局错误: ${err.message}`)
  console.error('⚡ 降级为直接签到...')
  runCheckin().then(() => process.exit(0)).catch(() => process.exit(1))
})
