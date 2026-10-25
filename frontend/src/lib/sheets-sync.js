// Google Sheets sync (VITE_SHEETS=1 build).
//
// This build has no openGym server. Data lives on the phone as usual (guest mode), and is synced
// with a Google Sheet through the sheet's Apps Script web app — the same "Lift Log" sheet layout
// (Workouts / Sets / Cardio / Body / Templates tabs) that other tools, Claude included, already
// read. Two directions:
//
//   push  workouts logged in openGym  → Workouts + Sets rows, source "opengym"
//   pull  everything else in the sheet → read-only history in openGym:
//           Workouts rows from other sources (Strong, Lift Log) → workouts with ext: 'sheet'
//           Cardio rows (Strava)                                 → workouts with ext: 'strava'
//           Body rows (smart scale)                              → body-weight entries
//           Templates (only while openGym has no routines yet)   → routines
//
// Imported items carry an ext field and are replaced wholesale on every pull, so they are never pushed
// back and editing or deleting them in openGym doesn't touch the sheet.
//
// Everything below the network helpers is pure (state in, state out) and unit-tested beside this
// file.

import { EXIDX, registerCustom } from './exercises.js'
import { matchExercise } from './import-csv.js'
import { DEFAULT_GLYPH } from './glyphs.js'

export const SHEETS = import.meta.env.VITE_SHEETS === '1'

const CFG_KEY = 'og_sheets_v1'
const LB_TO_KG = 0.45359237
const SOURCE = 'opengym'

/* ---------------------------------------------------------------- config ---- */

export function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY))
    return c && c.url && c.token ? c : null
  } catch {
    return null
  }
}
export function saveCfg(c) {
  if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c))
  else localStorage.removeItem(CFG_KEY)
}

const SCRIPT_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/

/**
 * Read a connection from whatever was pasted: the link the sheet shows
 * (…?sheets=<web app url>&k=<key>) or just its query part.
 */
export function parseConnection(text) {
  const s = String(text || '').trim()
  if (!s) return null
  let q
  try {
    q = new URL(s).searchParams
  } catch {
    q = new URLSearchParams(s.replace(/^[?#]/, ''))
  }
  const url = (q.get('sheets') || '').trim()
  const token = (q.get('k') || '').trim()
  if (!SCRIPT_RE.test(url) || !/^[A-Za-z0-9]{24,}$/.test(token)) return null
  return { url, token }
}

/* --------------------------------------------------------------- helpers ---- */

const pad2 = n => String(n).padStart(2, '0')
/** Local "YYYY-MM-DD HH:MM", the sheet's date format. */
export const sheetDate = ms => {
  const d = new Date(ms)
  const day = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  return day + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}
const isoDay = ms => sheetDate(ms).slice(0, 10)
/** "YYYY-MM-DD HH:MM" (or ISO) in local time → ms */
const parseSheetDate = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ''))
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0)).getTime()
}
const round1 = x => Math.round(x * 10) / 10
const toLb = (w, unit) => (unit === 'kg' ? round1(w / LB_TO_KG) : round1(w))
const fromLb = (lb, unit) => (unit === 'kg' ? round1(lb * LB_TO_KG) : round1(lb))
const slug = s =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
const titleCase = s => String(s).replace(/\b[a-z]/g, c => c.toUpperCase())
const isWarm = s => s && (s.phase === 'warmup' || s.warmup === true)
const hashOf = str => {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/* ------------------------------------------------- exercise name mapping ---- */

/**
 * Sheet exercise names (Strong style, "Bench Press (Barbell)") ↔ openGym exercise ids.
 * The names map remembers which sheet name each id was imported under, so a lift logged in openGym
 * is written back with the same name as its history and the progress comparisons line up.
 */
export function idForName(name, ctx) {
  const key = String(name || '').trim()
  if (!key) return null
  if (ctx.byName[key]) return ctx.byName[key]
  let id = matchExercise(key)
  if (!id || !EXIDX[id]) {
    id = 'll-' + slug(key)
    if (!ctx.customs[id] && !EXIDX[id]) {
      ctx.customs[id] = {
        id,
        n: key.toLowerCase(),
        custom: true,
        eq: 'custom',
        tg: '',
        desc: '',
        bp: 'upper legs',
        srcName: key
      }
    }
  }
  ctx.byName[key] = id
  if (!ctx.names[id]) ctx.names[id] = key
  return id
}

export function nameForId(id, names, customEx) {
  if (names && names[id]) return names[id]
  const c = (customEx || []).find(x => x.id === id)
  if (c) return c.srcName || titleCase(c.n)
  const ex = EXIDX[id]
  return ex ? titleCase(ex.n) : String(id)
}

/* -------------------------------------------------- openGym → sheet rows ---- */

/** One openGym workout → the sheet's { id, wrow, srows } (see the Apps Script's sync op). */
export function toSheetRows(w, S, names) {
  const unit = S.unit === 'kg' ? 'kg' : 'lb'
  const id = 'og-' + w.id
  const date = sheetDate(w.start || Date.now())
  const routine = (S.routines || []).find(r => r.id === w.routineId)
  const srows = []
  const exercises = []
  let volume = 0
  let work = 0
  ;(w.entries || []).forEach(e => {
    const name = nameForId(e.id, names, S.customEx)
    const sets = (e.sets || []).filter(s => s && s.done)
    if (!sets.length) return
    const llSets = []
    sets.forEach((s, i) => {
      const warm = isWarm(s)
      const lb = s.w ? toLb(s.w, unit) : 0
      let seconds = ''
      let distance = ''
      if (s.min != null || s.speed != null) {
        seconds = Math.round((s.min || 0) * 60)
        distance = Math.round((s.speed || 0) * ((s.min || 0) / 60) * 1000) // meters
      } else if (s.sec != null) seconds = Math.round(s.sec)
      const rpe = s.rpe != null ? s.rpe : s.rir != null ? 10 - s.rir : ''
      srows.push([
        id,
        date,
        w.name || '',
        name,
        i + 1,
        warm ? 'W' : '',
        lb,
        s.r != null ? s.r : '',
        seconds,
        distance,
        rpe,
        i === 0 ? e.note || '' : '',
        SOURCE
      ])
      if (!warm) {
        work++
        volume += lb * (s.r || 0)
      }
      const ls = { w: lb, done: true }
      if (s.r != null) ls.r = s.r
      if (warm) ls.t = 'W'
      if (rpe !== '') ls.rpe = rpe
      if (seconds !== '') ls.sec = seconds
      if (distance !== '') ls.dist = distance
      llSets.push(ls)
    })
    exercises.push({ name, ...(e.note ? { note: e.note } : {}), sets: llSets })
  })
  const minutes = w.end && w.start && w.end > w.start ? Math.round((w.end - w.start) / 60000) : ''
  const json = {
    name: w.name || '',
    startedAt: new Date(w.start || Date.now()).toISOString(),
    endedAt: new Date(w.end || w.start || Date.now()).toISOString(),
    finished: true,
    template: routine ? routine.name : '',
    notes: w.note || '',
    exercises
  }
  const wrow = [
    id,
    date,
    w.name || '',
    SOURCE,
    routine ? routine.name : '',
    minutes,
    work,
    Math.round(volume),
    w.note || '',
    '', // updated_at, filled when sent
    JSON.stringify(json)
  ]
  return { id, wrow, srows }
}

/** Upserts for workouts that changed since the last push, and deletes for removed ones. */
export function buildPush(S, cfg) {
  const pushed = cfg.pushed || {}
  const names = cfg.names || {}
  const upserts = []
  const seen = {}
  ;(S.workouts || [])
    .filter(w => !w.ext)
    .forEach(w => {
      const u = toSheetRows(w, S, names)
      if (!u.srows.length) return
      const h = hashOf(JSON.stringify([u.wrow, u.srows]))
      seen[u.id] = h
      if (pushed[u.id] !== h) upserts.push(u)
    })
  const deletes = Object.keys(pushed).filter(id => !(id in seen))
  return { upserts, deletes, next: seen, body: buildBodyPush(S, cfg) }
}

/**
 * Weigh-ins to send: anything logged or changed in openGym since the sheet's Body tab was last
 * seen (cfg.bodySheet: date → lb), and dates removed in openGym. Weigh-ins that came from the
 * sheet and weren't touched match bodySheet, so they aren't sent back.
 */
export function buildBodyPush(S, cfg) {
  const unit = S.unit === 'kg' ? 'kg' : 'lb'
  const last = cfg.bodySheet || {}
  const next = { ...last }
  const upserts = []
  const have = new Set()
  ;(S.bodyweight || []).forEach(b => {
    if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.d)) || !(b.w > 0)) return
    const lb = toLb(b.w, unit)
    have.add(b.d)
    if (last[b.d] !== lb) {
      upserts.push({ date: b.d, lb })
      next[b.d] = lb
    }
  })
  const deletes = cfg.bodySheet ? Object.keys(last).filter(d => !have.has(d)) : []
  deletes.forEach(d => delete next[d])
  return { upserts, deletes, next }
}

/* -------------------------------------------------- sheet → openGym state ---- */

function fromSheetWorkout(row, S, ctx) {
  const ll = row.json
  if (!ll || !Array.isArray(ll.exercises)) return null
  const unit = S.unit === 'kg' ? 'kg' : 'lb'
  const start = Date.parse(ll.startedAt) || parseSheetDate(row.date)
  if (!start) return null
  const endMs = Date.parse(ll.endedAt)
  const entries = []
  ll.exercises.forEach(ex => {
    const id = idForName(ex.name, ctx)
    if (!id) return
    const sets = (ex.sets || [])
      .filter(s => s && s.done !== false)
      .map(s => {
        const base = s.t === 'W' ? { phase: 'warmup' } : {}
        if (ex.unit === 'sec' || (s.sec != null && !s.r)) {
          return {
            sec: s.sec != null ? s.sec : s.r || 0,
            w: fromLb(s.w || 0, unit),
            done: true,
            ...base
          }
        }
        const out = {
          w: fromLb(s.w || 0, unit),
          r: s.r != null ? s.r : s.dist || 0,
          done: true,
          ...base
        }
        if (s.rpe != null && s.rpe !== '') out.rpe = Number(s.rpe)
        return out
      })
    if (!sets.length) return
    const top = Math.max(0, ...sets.filter(s => !isWarm(s)).map(s => s.w || 0))
    entries.push({ id, sets, topW: top || null })
  })
  if (!entries.length) return null
  const vol = entries.reduce(
    (a, e) => a + e.sets.reduce((b, s) => b + (isWarm(s) ? 0 : (s.w || 0) * (s.r || 0)), 0),
    0
  )
  return {
    id: 'sh-' + row.id,
    ext: 'sheet',
    src: row.source || 'sheet',
    d: isoDay(start),
    start,
    end: endMs && endMs > start ? endMs : start,
    routineId: null,
    name: ll.name || 'Workout',
    entries,
    prs: [],
    vol: Math.round(vol),
    ...(ll.notes ? { note: String(ll.notes) } : {})
  }
}

const CARDIO_IDS = { Run: '0685', TrailRun: '0685', VirtualRun: '0685', Treadmill: '0685' }

function cardioExId(type, ctx) {
  if (CARDIO_IDS[type] && EXIDX[CARDIO_IDS[type]]) return CARDIO_IDS[type]
  const label = String(type || 'Cardio')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
  const id = 'cx-' + slug(label || 'cardio')
  if (!ctx.customs[id] && !EXIDX[id]) {
    ctx.customs[id] = {
      id,
      n: label.toLowerCase(),
      custom: true,
      eq: 'custom',
      tg: '',
      desc: '',
      bp: 'cardio',
      srcName: label
    }
  }
  return id
}

function fromCardioRow(c, ctx) {
  const start = parseSheetDate(c.date)
  if (!start || !(c.minutes > 0)) return null
  const km = (c.miles || 0) * 1.609344
  const speed = c.minutes > 0 ? Math.round((km / (c.minutes / 60)) * 10) / 10 : 0
  return {
    id: 'st-' + c.id,
    ext: 'strava',
    src: 'strava',
    d: isoDay(start),
    start,
    end: start + Math.round(c.minutes * 60000),
    routineId: null,
    name: c.name || c.type || 'Cardio',
    entries: [
      { id: cardioExId(c.type, ctx), sets: [{ min: c.minutes, speed, done: true }], topW: null }
    ],
    prs: [],
    vol: 0
  }
}

const PER_SIDE = /\bper (side|leg|arm)\b/i
const SUPERSET = /\bsuperset with\b/i
const RANGE = /×\s*(\d+)\s*[–-]\s*(\d+)/

/** Plan tab rows → { key: value } */
const planOf = resp => {
  const out = {}
  ;((resp && resp.plan && resp.plan.rows) || []).forEach(r => {
    if (Array.isArray(r) && r[0]) out[String(r[0])] = String(r[1] == null ? '' : r[1])
  })
  return out
}
/** "10:20" min/mile → km/h */
const paceToKmh = p => {
  const m = /^(\d+):(\d{2})$/.exec(String(p || '').trim())
  if (!m) return 0
  const min = +m[1] + +m[2] / 60
  return min > 0 ? round1((60 / min) * 1.609344) : 0
}

/**
 * A sheet template (Lift Log shape) → an openGym routine. Keeps rest, warm-up count, timed holds,
 * per-side work (openGym counts both sides, so per-side reps are doubled), rep ranges as double
 * progression, supersets, coaching notes, and the cardio the summary or plan calls for.
 */
export function routineFromTemplate(t, ctx, unit, plan = {}) {
  const list = t.exercises || []
  const ex = []
  const srcIdx = []
  list.forEach((e, i) => {
    const id = idForName(e.name, ctx)
    if (!id) return
    const all = e.sets || []
    const warm = all.filter(s => s.t === 'W')
    const work = all.filter(s => s.t !== 'W')
    const first = work[0] || all[0] || {}
    const top = Math.max(0, ...work.map(s => Number(s.w) || 0))
    let note = String(e.note || '').trim()
    const side = e.unit !== 'm' && e.unit !== 'sec' && PER_SIDE.test(note)
    const cfg = { id, sets: Math.max(1, work.length || 1) }
    if (e.unit === 'sec') {
      cfg.mode = 'time'
      cfg.sec = Math.max(1, Number(first.r) || 45)
      cfg.weight = fromLb(top, unit)
    } else {
      if (e.unit === 'm') note = (first.r || 0) + ' m per set. ' + note
      const reps = Math.max(1, Number(first.r) || 8)
      cfg.mode = 'reps'
      cfg.reps = side ? reps * 2 : reps
      cfg.weight = fromLb(top, unit)
      if (side) cfg.side = true
      const range = e.unit === 'm' ? null : RANGE.exec(note)
      if (top > 0 && range && +range[1] < +range[2]) {
        cfg.prog = 'double'
        cfg.repsMin = +range[1] * (side ? 2 : 1)
        cfg.reps = +range[2] * (side ? 2 : 1)
      }
    }
    if (!(top > 0)) {
      cfg.bodyweight = true
      cfg.prog = 'off'
    }
    if (warm.length) cfg.warmupSets = Math.min(5, warm.length)
    if (e.rest > 0) cfg.restSec = Math.round(e.rest)
    if (note) cfg.note = note.slice(0, 500)
    ex.push(cfg)
    srcIdx.push(i)
  })
  // "Superset with X" pairs an exercise with the one after it.
  ex.forEach((cfg, k) => {
    if (cfg.note && SUPERSET.test(cfg.note) && ex[k + 1]) {
      const sg = 'ss' + (k + 1)
      cfg.sg = sg
      ex[k + 1].sg = sg
    }
  })
  // Session-level coaching note rides on the first exercise.
  const tnote = String(t.note || '').trim()
  if (tnote && ex[0])
    ex[0].note = ('Session: ' + tnote + (ex[0].note ? ' · ' + ex[0].note : '')).slice(0, 500)

  // Cardio the template's summary or the plan calls for.
  const summary = String(t.summary || '')
  const easy = paceToKmh(plan.easy_pace) || 9
  const walk = /then (\d+) min[^,·]*walk/i.exec(summary)
  if (walk && EXIDX['3666'])
    ex.push({ id: '3666', sets: 1, min: +walk[1], speed: 5, note: 'Easy incline walk.' })
  const intervals = /(\d+)\s*×\s*1-min intervals/i.exec(summary)
  if (intervals && EXIDX['0685']) {
    const rounds = +plan.intervals_start_rounds || +intervals[1]
    const work = +plan.interval_work_sec || 60
    const rest = +plan.interval_rest_sec || 60
    ex.push({
      id: '0685',
      sets: rounds,
      min: round1(work / 60),
      speed: round1(easy * 1.3),
      restSec: rest,
      note:
        'Intervals: ' +
        work +
        ' s hard, ' +
        rest +
        ' s easy. Rounds grow with the plan; see your weekly review.'
    })
  }
  if (/easy run/i.test(summary) && EXIDX['0685']) {
    const min = +plan.easy_run_start_min || 35
    ex.unshift({
      id: '0685',
      sets: 1,
      min,
      speed: easy,
      note:
        'Easy run first' +
        (plan.easy_pace ? ', slower than ' + plan.easy_pace + ' per mile' : '') +
        '. Minutes grow with the plan; see your weekly review.'
    })
  }
  return { id: 'tpl-' + slug(t.id || t.name), name: t.name || 'Routine', emoji: DEFAULT_GLYPH, ex }
}

/**
 * Merge a pull response into a copy of state S. Imported items are replaced wholesale; the
 * user's own workouts, routines and manual weigh-ins are left alone.
 * Returns { S, names, counts }.
 */
export function mergePull(S0, resp, prevNames = {}, opts = {}) {
  const S = JSON.parse(JSON.stringify(S0))
  const unit = S.unit === 'kg' ? 'kg' : 'lb'
  const ctx = { byName: {}, names: { ...prevNames }, customs: {} }
  ;(S.customEx || []).forEach(c => {
    if (c.srcName) ctx.byName[c.srcName] = c.id
  })
  Object.keys(prevNames).forEach(id => {
    if (!ctx.byName[prevNames[id]]) ctx.byName[prevNames[id]] = id
  })

  const imported = []
  ;(resp.workouts || []).forEach(row => {
    const w = fromSheetWorkout(row, S, ctx)
    if (w) imported.push(w)
  })
  const cardio = []
  ;(resp.cardio || []).forEach(c => {
    const w = fromCardioRow(c, ctx)
    if (w) cardio.push(w)
  })

  S.workouts = (S.workouts || [])
    .filter(w => !w.ext)
    .concat(imported, cardio)
    .sort((a, b) => (a.start || 0) - (b.start || 0))

  // weight suggestions from the newest imported set of each lift (never lowering a newer one)
  S.exWeights = S.exWeights || {}
  imported.forEach(w =>
    w.entries.forEach(e => {
      if (!e.topW) return
      const cur = S.exWeights[e.id]
      if (!cur || w.d >= cur.d) S.exWeights[e.id] = { w: e.topW, d: w.d }
    })
  )

  let weighIns = 0
  if (Array.isArray(resp.body)) {
    const fromSheet = new Map()
    resp.body.forEach(b => {
      if (b && /^\d{4}-\d{2}-\d{2}/.test(String(b.date)) && b.lb > 0) {
        const d = String(b.date).slice(0, 10)
        fromSheet.set(d, { d, w: fromLb(b.lb, unit), t: parseSheetDate(d), ext: 'sheet' })
      }
    })
    weighIns = fromSheet.size
    S.bodyweight = (S.bodyweight || [])
      .filter(b => !b.ext && !fromSheet.has(b.d))
      .concat([...fromSheet.values()])
      .sort((a, b) => (a.d < b.d ? -1 : 1))
  }

  // Templates become routines the first time, or on request (Settings → Re-import routines),
  // which replaces only the routines that came from the sheet and keeps any made in openGym.
  let routines = 0
  const tpls = Array.isArray(resp.templates) ? resp.templates : []
  if (tpls.length && (opts.replaceRoutines || !(S.routines || []).length)) {
    const plan = planOf(resp)
    const fresh = tpls.map(t => routineFromTemplate(t, ctx, unit, plan)).filter(r => r.ex.length)
    const ids = new Set(fresh.map(r => r.id))
    const kept = (S.routines || []).filter(r => !ids.has(r.id) && !String(r.id).startsWith('tpl-'))
    S.routines = fresh.concat(kept)
    // a weekday pointing at a routine that no longer exists falls back to rest
    const live = new Set(S.routines.map(r => r.id))
    Object.keys(S.week || {}).forEach(d => {
      if (S.week[d] && !live.has(S.week[d])) delete S.week[d]
    })
    routines = fresh.length
  }

  const have = new Set((S.customEx || []).map(c => c.id))
  S.customEx = (S.customEx || []).concat(Object.values(ctx.customs).filter(c => !have.has(c.id)))

  const bodySheet = {}
  ;(resp.body || []).forEach(b => {
    if (b && /^\d{4}-\d{2}-\d{2}/.test(String(b.date)) && b.lb > 0)
      bodySheet[String(b.date).slice(0, 10)] = round1(Number(b.lb))
  })

  return {
    S,
    names: ctx.names,
    bodySheet: Array.isArray(resp.body) ? bodySheet : null,
    counts: { workouts: imported.length, cardio: cardio.length, weighIns, routines }
  }
}

/* --------------------------------------------------------------- network ---- */

async function post(cfg, body) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    // text/plain keeps this a "simple" request: no CORS preflight, which Apps Script can't answer
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: cfg.token })
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || 'sync_failed')
  return j
}

/** Check a connection before saving it. */
export async function testConnection(cfg) {
  await post(cfg, { op: 'ping' })
  return true
}

/** Fetch, then merge into whatever the state is NOW (it may have changed while waiting). */
export async function pullFromSheet(getS, cfg, opts = {}) {
  const resp = await post(cfg, { op: 'pull' })
  const out = mergePull(getS(), resp, cfg.names || {}, opts)
  registerCustom(out.S.customEx)
  out.insights = resp.insights || {}
  return out
}

export async function pushToSheet(S, cfg) {
  const { upserts, deletes, next, body } = buildPush(S, cfg)
  if (!upserts.length && !deletes.length && !body.upserts.length && !body.deletes.length)
    return { wrote: 0, next, bodyNext: body.next }
  const now = new Date().toISOString()
  upserts.forEach(u => {
    u.wrow[9] = now
  })
  // cardio:false — this push doesn't need Strava fetched or cardio sent back
  await post(cfg, {
    op: 'sync',
    upserts,
    deletes,
    bodyUpserts: body.upserts,
    bodyDeletes: body.deletes,
    cardio: false
  })
  return { wrote: upserts.length + deletes.length + body.upserts.length, next, bodyNext: body.next }
}
