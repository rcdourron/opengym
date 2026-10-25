import { describe, it, expect } from 'vitest'
import {
  parseConnection,
  toSheetRows,
  buildPush,
  mergePull,
  sheetDate,
  routineFromTemplate,
  buildBodyPush
} from './sheets-sync.js'

const URL0 = 'https://script.google.com/macros/s/AKfycbTEST_abc-123/exec'
const KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'

describe('parseConnection', () => {
  it('reads the link the sheet shows', () => {
    const link = 'https://x.github.io/opengym/?sheets=' + encodeURIComponent(URL0) + '&k=' + KEY
    expect(parseConnection(link)).toEqual({ url: URL0, token: KEY })
    expect(parseConnection('  ' + link + '\n')).toEqual({ url: URL0, token: KEY })
  })
  it('rejects anything else', () => {
    expect(parseConnection('')).toBeNull()
    expect(parseConnection('https://example.com/?sheets=https://evil.com&k=' + KEY)).toBeNull()
    expect(parseConnection('?sheets=' + encodeURIComponent(URL0) + '&k=short')).toBeNull()
  })
})

const base = () => ({
  unit: 'lb',
  workouts: [],
  routines: [],
  customEx: [],
  bodyweight: [],
  exWeights: {}
})

const strongRow = {
  id: 'strong-20261020T180000',
  source: 'strong',
  date: '2026-10-20 18:00',
  json: {
    name: 'Push',
    startedAt: '2026-10-20T22:00:00.000Z',
    endedAt: '2026-10-20T23:00:00.000Z',
    exercises: [
      {
        name: 'Bench Press (Barbell)',
        sets: [
          { w: 95, r: 10, done: true, t: 'W' },
          { w: 155, r: 8, done: true, rpe: 8 },
          { w: 155, r: 7, done: true }
        ]
      },
      { name: 'Plank', unit: 'sec', sets: [{ w: 0, r: 45, done: true }] },
      { name: 'Zzz Totally Made Up Lift', sets: [{ w: 20, r: 12, done: true }] }
    ]
  }
}

describe('mergePull', () => {
  it('imports sheet workouts, cardio, weigh-ins and templates', () => {
    const resp = {
      workouts: [strongRow],
      cardio: [
        {
          id: '111',
          date: '2026-10-21 07:00',
          type: 'Run',
          name: 'Morning Run',
          minutes: 30,
          miles: 3
        },
        { id: '222', date: '2026-10-22 07:00', type: 'Ride', name: 'Ride', minutes: 60, miles: 15 }
      ],
      body: [
        { date: '2026-10-20', lb: 201.3 },
        { date: '2026-10-16', lb: 201.6 }
      ],
      templates: [
        {
          id: 'push-a',
          name: 'Push A',
          exercises: [
            {
              name: 'Bench Press (Barbell)',
              rest: 150,
              sets: [
                { w: 95, r: 10, t: 'W' },
                { w: 155, r: 8 },
                { w: 155, r: 8 }
              ]
            }
          ]
        }
      ]
    }
    const { S, names, counts } = mergePull(base(), resp)
    expect(counts).toEqual({ workouts: 1, cardio: 2, weighIns: 2, routines: 1 })
    const w = S.workouts.find(x => x.id === 'sh-strong-20261020T180000')
    expect(w.ext).toBe('sheet')
    expect(w.entries).toHaveLength(3)
    expect(w.entries[0].sets[0].phase).toBe('warmup')
    expect(w.entries[0].topW).toBe(155)
    expect(w.entries[1].sets[0]).toMatchObject({ sec: 45, w: 0 })
    // unknown names become custom exercises, remembered by their sheet name
    const custom = S.customEx.find(c => c.srcName === 'Zzz Totally Made Up Lift')
    expect(custom).toBeTruthy()
    expect(names[custom.id]).toBe('Zzz Totally Made Up Lift')
    // cardio: run maps to the library's run, a ride becomes a custom cardio exercise
    const run = S.workouts.find(x => x.id === 'st-111')
    expect(run.entries[0].sets[0].min).toBe(30)
    expect(run.entries[0].sets[0].speed).toBeCloseTo(9.7, 1)
    expect(S.customEx.find(c => c.id === 'cx-ride').bp).toBe('cardio')
    expect(S.bodyweight.map(b => b.w)).toEqual([201.6, 201.3])
    expect(S.routines[0].ex[0]).toMatchObject({
      sets: 2,
      reps: 8,
      weight: 155,
      restSec: 150,
      warmupSets: 1
    })
    expect(S.exWeights[w.entries[0].id].w).toBe(155)
  })

  it('replaces imported items on the next pull and keeps the user’s own', () => {
    const mine = {
      id: 'abc',
      d: '2026-10-23',
      start: Date.parse('2026-10-23T22:00:00Z'),
      end: 0,
      name: 'Mine',
      entries: [],
      prs: []
    }
    let S = { ...base(), workouts: [mine], bodyweight: [{ d: '2026-10-01', w: 199 }] }
    S = mergePull(S, { workouts: [strongRow], body: [{ date: '2026-10-20', lb: 201 }] }).S
    S = mergePull(S, { workouts: [strongRow], body: [{ date: '2026-10-20', lb: 201 }] }).S
    expect(S.workouts.filter(w => w.ext)).toHaveLength(1)
    expect(S.workouts.find(w => w.id === 'abc')).toBeTruthy()
    expect(S.bodyweight).toHaveLength(2)
    // existing routines are never overwritten by templates
    S.routines = [{ id: 'r', name: 'Mine', ex: [] }]
    S = mergePull(S, {
      templates: [{ id: 't', name: 'T', exercises: [{ name: 'Plank', sets: [{ r: 30 }] }] }]
    }).S
    expect(S.routines.map(r => r.name)).toEqual(['Mine'])
  })

  it('converts pounds when the profile is in kg', () => {
    const { S } = mergePull(
      { ...base(), unit: 'kg' },
      { workouts: [strongRow], body: [{ date: '2026-10-20', lb: 200 }] }
    )
    expect(S.workouts[0].entries[0].sets[1].w).toBeCloseTo(70.3, 1)
    expect(S.bodyweight[0].w).toBeCloseTo(90.7, 1)
  })
})

describe('push', () => {
  const S0 = () => {
    const { S, names } = mergePull(base(), { workouts: [strongRow] })
    const benchId = S.workouts[0].entries[0].id
    const start = new Date(2026, 9, 24, 18, 5).getTime()
    S.routines = [{ id: 'r1', name: 'Push A', ex: [] }]
    S.workouts.push({
      id: 'w1',
      d: '2026-10-24',
      start,
      end: start + 55 * 60000,
      routineId: 'r1',
      name: 'Push A',
      note: 'felt good',
      entries: [
        {
          id: benchId,
          note: 'paused reps',
          sets: [
            { w: 95, r: 10, done: true, phase: 'warmup' },
            { w: 160, r: 8, done: true, rir: 2 },
            { w: 160, r: 6, done: false }
          ]
        },
        { id: '0685', sets: [{ min: 10, speed: 9.6, done: true }] }
      ],
      prs: []
    })
    return { S, names }
  }

  it('writes openGym workouts in the sheet’s row format, with history names', () => {
    const { S, names } = S0()
    const u = toSheetRows(
      S.workouts.find(w => w.id === 'w1'),
      S,
      names
    )
    expect(u.id).toBe('og-w1')
    expect(u.wrow.slice(0, 9)).toEqual([
      'og-w1',
      sheetDate(S.workouts[1].start),
      'Push A',
      'opengym',
      'Push A',
      55,
      2,
      1280,
      'felt good'
    ])
    expect(u.srows).toHaveLength(3)
    expect(u.srows[0].slice(3, 13)).toEqual([
      'Bench Press (Barbell)',
      1,
      'W',
      95,
      10,
      '',
      '',
      '',
      'paused reps',
      'opengym'
    ])
    expect(u.srows[1].slice(3, 11)).toEqual(['Bench Press (Barbell)', 2, '', 160, 8, '', '', 8])
    expect(u.srows[2].slice(6, 10)).toEqual([0, '', 600, 1600])
    const json = JSON.parse(u.wrow[10])
    expect(json.exercises[0].sets).toHaveLength(2)
    expect(json.template).toBe('Push A')
  })

  it('only sends what changed, never imported workouts, and deletes removed ones', () => {
    const { S, names } = S0()
    const first = buildPush(S, { names, pushed: {} })
    expect(first.upserts.map(u => u.id)).toEqual(['og-w1'])
    expect(first.deletes).toEqual([])
    const again = buildPush(S, { names, pushed: first.next })
    expect(again.upserts).toHaveLength(0)
    S.workouts = S.workouts.filter(w => w.id !== 'w1')
    const gone = buildPush(S, { names, pushed: first.next })
    expect(gone.deletes).toEqual(['og-w1'])
  })
})

describe('routineFromTemplate', () => {
  const ctx = () => ({ byName: {}, names: {}, customs: {} })
  const plan = {
    easy_pace: '10:20',
    easy_run_start_min: '35',
    intervals_start_rounds: '6',
    interval_work_sec: '60',
    interval_rest_sec: '60'
  }
  const tplA = {
    id: 'day-a',
    name: 'Day A',
    summary: 'Squat, bench · ~75 min, then 15 min easy incline walk',
    note: 'Warm up first.',
    exercises: [
      {
        name: 'Bird Dog',
        rest: 30,
        note: 'Per side. Hold 5 sec.',
        sets: [
          { w: 0, r: 6 },
          { w: 0, r: 6 }
        ]
      },
      {
        name: 'Side Plank',
        unit: 'sec',
        rest: 30,
        note: 'Per side.',
        sets: [
          { w: 0, r: 20 },
          { w: 0, r: 20 }
        ]
      },
      {
        name: 'Bench Press (Barbell)',
        rest: 150,
        note: '3 × 6–8. Add 5 lb once all sets hit 8.',
        sets: [
          { w: 95, r: 10, t: 'W' },
          { w: 135, r: 5, t: 'W' },
          { w: 155, r: 8 },
          { w: 155, r: 8 },
          { w: 155, r: 8 }
        ]
      },
      {
        name: 'Pallof Press (Cable)',
        rest: 30,
        note: 'Per side. Superset with Hammer Curl.',
        sets: [{ w: null, r: 10 }]
      },
      {
        name: 'Hammer Curl (Dumbbell)',
        rest: 60,
        note: '3 × 10–12.',
        sets: [
          { w: 30, r: 12 },
          { w: 30, r: 12 }
        ]
      },
      {
        name: 'Suitcase Carry',
        unit: 'm',
        rest: 60,
        note: 'Per side, 50 lb.',
        sets: [{ w: 50, r: 40 }]
      }
    ]
  }

  it('keeps rest, warm-ups, timed holds, per-side reps, ranges, supersets and notes', () => {
    const r = routineFromTemplate(tplA, ctx(), 'lb', plan)
    expect(r.id).toBe('tpl-day-a')
    const [bird, plank, bench, pallof, curl, carry, walk] = r.ex
    expect(bird).toMatchObject({
      sets: 2,
      mode: 'reps',
      reps: 12,
      side: true,
      bodyweight: true,
      prog: 'off',
      restSec: 30
    })
    expect(bird.note.startsWith('Session: Warm up first.')).toBe(true)
    expect(plank).toMatchObject({ mode: 'time', sec: 20, sets: 2 })
    expect(plank.side).toBeUndefined()
    expect(bench).toMatchObject({
      sets: 3,
      reps: 8,
      repsMin: 6,
      prog: 'double',
      weight: 155,
      warmupSets: 2,
      restSec: 150
    })
    expect(pallof.sg).toBeTruthy()
    expect(curl.sg).toBe(pallof.sg)
    expect(curl).toMatchObject({ prog: 'double', repsMin: 10, reps: 12, weight: 30 })
    expect(carry).toMatchObject({ reps: 40, weight: 50 })
    expect(carry.side).toBeUndefined()
    expect(carry.note.startsWith('40 m per set.')).toBe(true)
    expect(walk).toMatchObject({ id: '3666', sets: 1, min: 15 })
  })

  it('adds intervals and the easy run from the plan', () => {
    const b = routineFromTemplate(
      { id: 'b', name: 'B', summary: 'Hinge · then 6 × 1-min intervals', exercises: [] },
      ctx(),
      'lb',
      plan
    )
    expect(b.ex[0]).toMatchObject({ id: '0685', sets: 6, min: 1, restSec: 60 })
    const c = routineFromTemplate(
      {
        id: 'c',
        name: 'C',
        summary: 'Ski add-on after the day-2 easy run',
        exercises: [{ name: 'Glute Bridge', sets: [{ w: 0, r: 12 }] }]
      },
      ctx(),
      'lb',
      plan
    )
    expect(c.ex[0]).toMatchObject({ id: '0685', sets: 1, min: 35 })
    expect(c.ex[0].speed).toBeCloseTo(9.3, 1)
    expect(c.ex[0].note).toContain('10:20')
  })

  it('re-import replaces sheet routines only and clears stale weekdays', () => {
    let S = {
      ...base(),
      routines: [
        { id: 'tpl-old', name: 'Old', ex: [] },
        { id: 'mine', name: 'Mine', ex: [] }
      ],
      week: { 1: 'tpl-old', 3: 'mine' }
    }
    S = mergePull(
      S,
      { templates: [tplA], plan: { rows: [['easy_pace', '10:20']] } },
      {},
      { replaceRoutines: true }
    ).S
    expect(S.routines.map(r => r.id)).toEqual(['tpl-day-a', 'mine'])
    expect(S.week).toEqual({ 3: 'mine' })
  })
})

describe('weigh-ins', () => {
  it('sends weigh-ins logged or changed in openGym, not ones that came from the sheet', () => {
    const { S, bodySheet } = mergePull(base(), { body: [{ date: '2026-10-20', lb: 201.3 }] })
    expect(bodySheet).toEqual({ '2026-10-20': 201.3 })
    S.bodyweight.push({ d: '2026-10-25', w: 200.4, t: 0 })
    const b = buildBodyPush(S, { bodySheet })
    expect(b.upserts).toEqual([{ date: '2026-10-25', lb: 200.4 }])
    expect(b.deletes).toEqual([])
    // after sending, nothing is resent
    expect(buildBodyPush(S, { bodySheet: b.next }).upserts).toEqual([])
    // editing a sheet weigh-in sends it; removing one deletes it
    S.bodyweight[0].w = 201.0
    S.bodyweight = S.bodyweight.filter(x => x.d !== '2026-10-25')
    const c = buildBodyPush(S, { bodySheet: b.next })
    expect(c.upserts).toEqual([{ date: '2026-10-20', lb: 201 }])
    expect(c.deletes).toEqual(['2026-10-25'])
  })
  it('converts kg weigh-ins to pounds and never deletes before the first pull', () => {
    const S = { ...base(), unit: 'kg', bodyweight: [{ d: '2026-10-25', w: 91, t: 0 }] }
    const b = buildBodyPush(S, {})
    expect(b.upserts).toEqual([{ date: '2026-10-25', lb: 200.6 }])
    expect(b.deletes).toEqual([])
  })
})
