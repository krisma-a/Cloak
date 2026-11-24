// Run with: npm test   (fake data only)
// The send log must never hold text from a case. These tests feed it hostile input and check the
// record, the CSV and the Firestore rules file all stay within the fixed lists.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyEntities, PLACEHOLDER_PREFIXES } from './placeholders.ts'
import {
  buildSendLog,
  CSV_COLUMNS,
  LOG_PLACES,
  LOG_STEPS,
  MODEL_PATTERN,
  SEND_LOG_FIELDS,
  SETTINGS_VERSION_PATTERN,
  sendLogsToCsv,
  validateSendLog,
  type SendLogInput,
  type SendLogRow,
} from './sendLog.ts'

const HASH = 'a'.repeat(64)

function input(overrides: Partial<SendLogInput> = {}): SendLogInput {
  return {
    userId: 'uid_Fake-123',
    blocked: false,
    counts: { EMPLOYEE: 3, SALARY: 1 },
    settingsVersion: HASH,
    model: 'gemini-3.6-flash',
    steps: [
      { step: 'redaction', ranOn: 'on_device' },
      { step: 'names', ranOn: 'on_device' },
      { step: 'drafting', ranOn: 'in_cloud' },
      { step: 'restore', ranOn: 'on_device' },
    ],
    ...overrides,
  }
}

/** Every string anywhere inside a value. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(allStrings)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...allStrings(v)])
  return []
}

test('a record holds the counts, whether it was blocked, the settings, the model and where each step ran', () => {
  const record = buildSendLog(input())
  assert.deepEqual(record, {
    userId: 'uid_Fake-123',
    schema: 1,
    blocked: false,
    counts: { EMPLOYEE: 3, SALARY: 1 },
    settingsVersion: HASH,
    model: 'gemini-3.6-flash',
    ranOn: { redaction: 'on_device', names: 'on_device', drafting: 'in_cloud', restore: 'on_device' },
  })
  assert.equal(validateSendLog(record), null)
})

test('a blocked send has no model and still records where the steps that ran happened', () => {
  const record = buildSendLog(input({ blocked: true, model: null, steps: [{ step: 'redaction', ranOn: 'in_browser' }] }))
  assert.equal(record.blocked, true)
  assert.equal(record.model, null)
  assert.deepEqual(record.ranOn, { redaction: 'in_browser' })
  assert.equal(validateSendLog(record), null)
})

test('text smuggled into any field is dropped, so a record can never carry text', () => {
  const secret = 'Maria Santos maria.santos@example.com 123-45-6789'
  const record = buildSendLog(
    input({
      counts: { EMPLOYEE: 2, [secret]: 5, SALARY: 1.5, ROLE: -1, DOB: 1e9, ID: Number.NaN },
      settingsVersion: secret,
      model: secret,
      steps: [
        { step: 'redaction', ranOn: 'on_device' },
        { step: secret, ranOn: 'in_cloud' },
        { step: 'drafting', ranOn: secret },
        { step: 'detail', ranOn: 'on_device' },
      ],
    }),
  )
  assert.deepEqual(record.counts, { EMPLOYEE: 2 })
  assert.equal(record.settingsVersion, 'unknown')
  assert.equal(record.model, null)
  assert.deepEqual(record.ranOn, { redaction: 'on_device' })
  for (const text of allStrings(record)) assert.ok(!text.includes('Maria') && !text.includes('@') && !text.includes('123-45'))
  assert.equal(validateSendLog(record), null)
})

test('every string in a record comes from a short fixed list or matches a strict pattern', () => {
  const record = buildSendLog(input())
  const fixed = new Set<string>([...SEND_LOG_FIELDS, ...PLACEHOLDER_PREFIXES, ...LOG_STEPS, ...LOG_PLACES, record.userId])
  for (const text of allStrings(record)) {
    assert.ok(fixed.has(text) || SETTINGS_VERSION_PATTERN.test(text) || MODEL_PATTERN.test(text), `unexpected string in the record`)
    assert.ok(text.length <= 128)
  }
})

test('a real redaction result gives counts only, with no name, value or placeholder text', () => {
  const note = 'Pat Rivers (EMP-40912) wrote to pat.rivers@example.com. Salary: $61,200.'
  const { map } = applyEntities(note, [
    { text: 'Pat Rivers', category: 'PERSON' },
    { text: 'EMP-40912', category: 'EMPLOYEE_ID' },
    { text: 'pat.rivers@example.com', category: 'EMAIL' },
    { text: '$61,200', category: 'SALARY' },
  ])
  const counts: Record<string, number> = {}
  for (const placeholder of Object.keys(map.originals)) {
    const prefix = placeholder.slice(1, placeholder.lastIndexOf('_'))
    counts[prefix] = (counts[prefix] ?? 0) + 1
  }
  const record = buildSendLog(input({ counts }))
  assert.deepEqual(record.counts, { EMPLOYEE: 1, ID: 1, EMAIL: 1, SALARY: 1 })
  const json = JSON.stringify(record)
  for (const original of Object.values(map.originals)) assert.ok(!json.includes(original))
  assert.ok(!json.includes('['), 'not even a placeholder such as [EMPLOYEE_1]')
})

test('a bad user id is refused rather than logged', () => {
  for (const userId of ['', 'has space', 'a/b', 'x'.repeat(129)]) assert.throws(() => buildSendLog(input({ userId })), /user id/)
})

test('validateSendLog rejects extra fields, free text and wrong types, and never repeats a value', () => {
  const good = buildSendLog(input())
  const bad: Array<[string, unknown]> = [
    ['a note field', { ...good, note: 'Pat Rivers was late' }],
    ['a text model', { ...good, model: 'Pat Rivers was late' }],
    ['text as settings version', { ...good, settingsVersion: 'Pat Rivers' }],
    ['an unknown count key', { ...good, counts: { 'Pat Rivers': 1 } }],
    ['a fractional count', { ...good, counts: { EMPLOYEE: 1.5 } }],
    ['text as a place', { ...good, ranOn: { redaction: 'Pat Rivers' } }],
    ['an unknown step', { ...good, ranOn: { 'Pat Rivers': 'on_device' } }],
    ['blocked as text', { ...good, blocked: 'no' }],
    ['a missing field', { userId: good.userId }],
  ]
  for (const [name, record] of bad) {
    const problem = validateSendLog(record)
    assert.ok(problem, `${name} should be refused`)
    assert.ok(!problem.includes('Pat'), 'the message must not repeat the value')
  }
  assert.ok(validateSendLog('text'))
  assert.ok(validateSendLog(null))
})

function row(overrides: Partial<SendLogRow> = {}): SendLogRow {
  return { ...buildSendLog(input()), id: 'doc1', createdAt: '2026-11-23T10:00:00.000Z', ...overrides }
}

test('the CSV has one header, one row per send, a column per category and step, and CRLF line ends', () => {
  const csv = sendLogsToCsv([
    row(),
    row({ id: 'doc2', createdAt: null, blocked: true, model: null, counts: {}, ranOn: { redaction: 'rules' } }),
  ])
  const lines = csv.split('\r\n')
  assert.equal(lines.at(-1), '', 'ends with a line break')
  assert.equal(lines.length, 4)
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.equal(CSV_COLUMNS.length, 5 + PLACEHOLDER_PREFIXES.length + LOG_STEPS.length)

  const header = lines[0].split(',')
  const first = lines[1].split(',')
  const second = lines[2].split(',')
  const at = (cells: string[], name: string) => cells[header.indexOf(name)]
  assert.equal(at(first, 'created_at'), '2026-11-23T10:00:00.000Z')
  assert.equal(at(first, 'user_id'), 'uid_Fake-123')
  assert.equal(at(first, 'blocked'), 'false')
  assert.equal(at(first, 'model'), 'gemini-3.6-flash')
  assert.equal(at(first, 'count_employee'), '3')
  assert.equal(at(first, 'count_email'), '0', 'a kind that did not occur is 0')
  assert.equal(at(first, 'ran_drafting'), 'in_cloud')
  assert.equal(at(first, 'ran_cross_check'), '', 'a step that did not happen is empty')
  assert.equal(at(second, 'created_at'), '')
  assert.equal(at(second, 'blocked'), 'true')
  assert.equal(at(second, 'model'), '')
  assert.equal(at(second, 'ran_redaction'), 'rules')
})

test('with no logs the CSV is just the header', () => {
  assert.equal(sendLogsToCsv([]), `${CSV_COLUMNS.join(',')}\r\n`)
})

test('CSV cells that a spreadsheet could read as a formula or break a row are made safe', () => {
  // Real records cannot hold these values; this checks the escaping itself, as a second layer.
  const csv = sendLogsToCsv([row({ userId: '=cmd|calc', model: 'a,"b"\nc' })])
  const body = csv.split('\r\n')[1]
  assert.ok(body.includes(",'=cmd|calc,"), 'a leading = is marked as text')
  assert.ok(body.includes('"a,""b""\nc"'), 'commas, quotes and line breaks are quoted')
})

// ---------------------------------------------------------------------------------------------
// The rules file and the code must agree. The Firestore emulator needs Java, so this checks the lists
// and patterns in firestore.rules against sendLog.ts instead.

const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')

function rulesList(name: string): string[] {
  const body = new RegExp(`function ${name}\\(\\) \\{\\s*return \\[([^\\]]*)\\];`).exec(rules)?.[1]
  assert.ok(body !== undefined, `firestore.rules should define ${name}()`)
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

function rulesCalls(fn: string): string[] {
  return [...rules.matchAll(new RegExp(`&& ${fn}\\(\\w+, '([^']*)'\\)`, 'g'))].map((m) => m[1])
}

test('firestore.rules allows exactly the fields, categories, steps and places that sendLog.ts uses', () => {
  assert.deepEqual(rulesList('sendLogFields'), [...SEND_LOG_FIELDS])
  assert.deepEqual(rulesList('countKeys'), [...PLACEHOLDER_PREFIXES])
  assert.deepEqual(rulesList('stepNames'), [...LOG_STEPS])
  assert.deepEqual(rulesList('placeNames'), [...LOG_PLACES])
  // Each one is also checked, one by one, inside the rules.
  assert.deepEqual(rulesCalls('countOk'), [...PLACEHOLDER_PREFIXES])
  assert.deepEqual(rulesCalls('placeOk'), [...LOG_STEPS])
})

test('firestore.rules uses the same patterns as sendLog.ts for the only strings a log may hold', () => {
  // Only the send log's own checks (usage records have their own, tested in usage.test.ts).
  const sendLogBody = /function validSendLog\(userId, log\) \{([\s\S]*?)\n {4}\}/.exec(rules)?.[1] ?? ''
  const patterns = [...sendLogBody.matchAll(/\.matches\('([^']*)'\)/g)].map((m) => m[1])
  assert.equal(patterns.length, 2)
  const version = new RegExp(patterns[0])
  const model = new RegExp(patterns[1])
  for (const good of [HASH, 'unknown']) assert.ok(version.test(good) && SETTINGS_VERSION_PATTERN.test(good))
  for (const bad of ['Pat Rivers', 'A'.repeat(64), `${HASH}0`, 'unknown ']) {
    assert.equal(version.test(bad), false)
    assert.equal(SETTINGS_VERSION_PATTERN.test(bad), false)
  }
  for (const good of ['gemini-3.6-flash', 'gemini-3.6-pro', 'x1']) assert.ok(model.test(good) && MODEL_PATTERN.test(good))
  for (const bad of ['Pat Rivers was late', 'a', '-x', 'a'.repeat(70)]) {
    assert.equal(model.test(bad), false)
    assert.equal(MODEL_PATTERN.test(bad), false)
  }
})

test('firestore.rules ties a log to its owner, makes it append-only, and denies everything else', () => {
  assert.match(rules, /match \/users\/\{userId\}\/sendLogs\/\{logId\} \{[\s\S]*allow read: if isSelf\(userId\);/)
  assert.match(rules, /allow create: if isSelf\(userId\) && validSendLog\(userId, request\.resource\.data\);/)
  assert.match(rules, /allow update, delete: if false;/)
  assert.match(rules, /log\.userId == userId/)
  assert.match(rules, /log\.createdAt == request\.time/)
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/)
  // The old broad rule let a user write anything under their own path, so it must be gone.
  assert.ok(!/match \/users\/\{userId\}\/\{document=\*\*\}/.test(rules))
})
