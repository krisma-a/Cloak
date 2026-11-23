import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confirmNoNames } from '../ai/guard.ts'
import { restore } from '../ai/placeholders.ts'
import { redactNotes, SendBlockedError, suggestRestrictions, writeDraft } from './fakeAi.ts'
import { SAMPLE_NOTE } from './sampleNote.ts'
import { accommodationBlockReason } from '../ai/restrictionPrompt.ts'
import {
  buildSegments,
  employeeOptions,
  fixLeaks,
  hasWorkToLose,
  hideText,
  makeLabeler,
  outgoing,
  reviewItems,
  toggleKept,
} from './review.ts'

test('the placeholder redaction hides every private detail in the sample note', async () => {
  const result = await redactNotes(SAMPLE_NOTE)
  assert.equal(result.status, 'ok')
  for (const secret of [
    'Maria', 'Santos', 'Chidi', 'Okafor', 'Nguyen', 'EMP-40912', 'maria.santos@example.com',
    '(555) 201-7788', '$68,500', '123-45-6789', 'diabetes',
  ]) {
    assert.ok(!result.redactedText.includes(secret), `${secret} should be hidden`)
  }
  // The break request is a work restriction, not a medical detail, so it stays visible.
  assert.ok(result.redactedText.includes('short break every 2 hours'))
})

test('buildSegments splits the text into plain text and details', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const segments = buildSegments(base, [])
  const details = segments.filter((s) => s.kind === 'detail')
  assert.ok(details.length >= 8)
  assert.ok(details.every((s) => s.kind === 'detail' && s.hidden))
  const rebuilt = segments.map((s) => (s.kind === 'text' ? s.text : s.placeholder)).join('')
  assert.equal(rebuilt, base.redactedText)
})

test('keeping a detail visible writes it back and removes it from the map', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const salary = Object.entries(base.map.originals).find(([, value]) => value === '$68,500')?.[0]
  assert.ok(salary)

  const kept = toggleKept([], salary)
  const out = outgoing(base, kept)
  assert.ok(out.redactedText.includes('$68,500'))
  assert.equal(out.map.originals[salary], undefined)
  // Kept salary is a fixed-shape detail, so the leak check must flag it and block sending.
  assert.equal(out.status, 'blocked')
  assert.deepEqual(out.leaks.map((leak) => leak.text), ['$68,500'])

  // Hide it again and the text is clean again.
  const hiddenAgain = outgoing(base, toggleKept(kept, salary))
  assert.equal(hiddenAgain.status, 'ok')
  assert.equal(hiddenAgain.redactedText, base.redactedText)
})

test('fixLeaks puts a kept salary back under a label', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const salary = Object.entries(base.map.originals).find(([, value]) => value === '$68,500')?.[0]
  assert.ok(salary)
  const fixed = fixLeaks(base, [salary])
  assert.deepEqual(fixed.kept, [])
  assert.equal(outgoing(fixed.base, fixed.kept).status, 'ok')
})

test('fixLeaks hides a fixed-shape detail the redaction missed', async () => {
  const empty = await redactNotes('Nothing private here.')
  const missed = { ...empty, redactedText: 'Email jo@example.com about it.' }
  const fixed = fixLeaks(missed, [])
  assert.equal(fixed.base.redactedText, 'Email [EMAIL_1] about it.')
  assert.equal(fixed.base.status, 'ok')
})

test('hideText hides every whole-word match, including name parts', async () => {
  const base = await redactNotes('Lee Park met Jo, and then Lee Park left while Jo stayed.')
  assert.equal(base.redactedText, '[EMPLOYEE_1] met Jo, and then [EMPLOYEE_1] left while Jo stayed.')

  const next = hideText(base, 'Jo', 'PERSON')
  assert.equal(next.redactedText, '[EMPLOYEE_1] met [EMPLOYEE_2], and then [EMPLOYEE_1] left while [EMPLOYEE_2] stayed.')
  assert.equal(next.map.originals['[EMPLOYEE_2]'], 'Jo')
})

test('hideText does nothing for text that is not there, or too short', async () => {
  const base = await redactNotes('Nothing private here.')
  assert.equal(hideText(base, 'Zed', 'PERSON'), base)
  assert.equal(hideText(base, ' x ', 'PERSON'), base)
})

test('makeLabeler uses plain words', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const label = makeLabeler(base.map)
  assert.equal(label('[EMPLOYEE_1]'), 'NAME 1')
  assert.equal(label('[EMPLOYEE_2]'), 'NAME 2')
  assert.equal(label('[MEDICAL_DETAIL_1]'), 'MEDICAL')
  assert.equal(label('[EMAIL_1]'), 'EMAIL')
  // The sample has two kinds of ID (employee ID and SSN), so they are numbered.
  assert.equal(label('[ID_1]'), 'ID 1')
  assert.equal(label('[ID_2]'), 'ID 2')
})

test('reviewItems lists each detail once with a count', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const items = reviewItems(buildSegments(base, []))
  const names = items.filter((item) => item.placeholder.startsWith('[EMPLOYEE_'))
  assert.ok(names.length >= 3)
  assert.ok(names.some((item) => item.count > 1)) // "Maria" appears more than once
  assert.equal(new Set(items.map((item) => item.placeholder)).size, items.length)
})

test('restoring the redacted note gives back the original', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const restored = restore(base.redactedText, base.map)
  assert.ok(restored.includes('Maria Santos'))
  assert.ok(restored.includes('maria.santos@example.com'))
})

test('writeDraft refuses to run without approval', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  await assert.rejects(() => writeDraft(outgoing(base, []), 'investigation', { approved: false }), SendBlockedError)
})

test('writeDraft is blocked while a leak is still visible', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const salary = Object.entries(base.map.originals).find(([, value]) => value === '$68,500')?.[0] ?? ''
  const leaky = outgoing(base, [salary])
  await assert.rejects(() => writeDraft(leaky, 'investigation', { approved: true }), SendBlockedError)
})

test('writeDraft is blocked until names are checked', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  await assert.rejects(
    () => writeDraft({ ...outgoing(base, []), names: 'unchecked' }, 'investigation', { approved: true }),
    SendBlockedError,
  )
  const confirmed = confirmNoNames({ ...outgoing(base, []), names: 'unchecked' })
  const draft = await writeDraft(confirmed, 'investigation', { approved: true })
  assert.ok(draft.restoredDraft.length > 0)
})

test('an investigation draft sends placeholders only and restores names afterwards', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const draft = await writeDraft(outgoing(base, []), 'investigation', { approved: true })
  assert.ok(!draft.receipt.sentText.includes('Maria'))
  assert.ok(!draft.receipt.sentText.includes('maria.santos@example.com'))
  assert.ok(draft.receipt.sentText.includes('[EMPLOYEE_1]'))
  assert.ok(draft.restoredDraft.includes('Maria Santos'))
  // Health details are never restored into an HR-file draft.
  assert.ok(!draft.restoredDraft.includes('diabetes'))
  assert.equal(draft.receipt.sha256.length, 64)
})

test('a manager email sends only the approved restrictions, never the notes', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const out = outgoing(base, [])
  const suggestions = await suggestRestrictions(out)
  assert.deepEqual(suggestions.items.map((item) => item.text), ['a short break every 2 hours'])

  await assert.rejects(() => writeDraft(out, 'accommodation', { approved: true }), SendBlockedError) // no plan yet

  const maria = Object.entries(out.map.originals).find(([, value]) => value === 'Maria Santos')?.[0] ?? ''
  const draft = await writeDraft(out, 'accommodation', {
    approved: true,
    accommodation: { employee: maria, restrictions: ['a short break every 2 hours'] },
  })
  assert.ok(draft.receipt.sentText.includes('a short break every 2 hours'))
  assert.ok(!draft.receipt.sentText.includes('Okafor'))
  assert.ok(!draft.receipt.sentText.includes('[MEDICAL_DETAIL_1]'))
  assert.ok(draft.restoredDraft.includes('Maria Santos'))
})

test('the "Who is this for?" list shows real names, but the value is always a placeholder', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const out = outgoing(base, [])
  const options = employeeOptions(out.map, makeLabeler(base.map))
  assert.ok(options.length >= 3)

  const maria = options.find((option) => option.text.startsWith('Maria Santos'))
  assert.ok(maria, 'the real name is what the person sees')
  assert.match(maria.text, /^Maria Santos \(sent as NAME \d+\)$/)
  for (const option of options) {
    assert.match(option.value, /^\[EMPLOYEE_\d+\]$/) // what the app keeps and sends
    assert.notEqual(option.value, out.map.originals[option.value]) // never the real name
  }

  // A real name is not accepted as the choice, so it can't be what gets used.
  const plan = { employee: 'Maria Santos', restrictions: ['a short break every 2 hours'] }
  assert.match(accommodationBlockReason(plan, out.map, out.redactedText) ?? '', /choose which employee/)
})

test('a manager email built from the dropdown value sends placeholders only', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const out = outgoing(base, [])
  const options = employeeOptions(out.map, makeLabeler(base.map))
  const maria = options.find((option) => option.text.startsWith('Maria Santos'))
  assert.ok(maria)

  const draft = await writeDraft(out, 'accommodation', {
    approved: true,
    accommodation: { employee: maria.value, restrictions: ['a short break every 2 hours'] },
  })
  const sent = draft.receipt.sentText
  assert.ok(sent.includes(`Employee: ${maria.value}`))
  // Neither any real value, nor the text the dropdown showed, is in what was sent.
  for (const original of Object.values(out.map.originals)) {
    assert.ok(!sent.includes(original), `"${original}" must not be sent`)
  }
  for (const option of options) assert.ok(!sent.includes(option.text))
  assert.ok(draft.restoredDraft.includes('Maria Santos')) // the real name comes back on this laptop only
})

test('the leave warning is wanted only while there is something to lose', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const draft = await writeDraft(outgoing(base, []), 'investigation', { approved: true })
  assert.equal(hasWorkToLose({ notes: '', base: null, draft: null }), false) // start screen, or after "Start over"
  assert.equal(hasWorkToLose({ notes: '  \n ', base: null, draft: null }), false) // only spaces
  assert.equal(hasWorkToLose({ notes: SAMPLE_NOTE, base: null, draft: null }), true) // text typed
  assert.equal(hasWorkToLose({ notes: '', base, draft: null }), true) // a redaction with real names in memory
  assert.equal(hasWorkToLose({ notes: '', base: null, draft }), true) // a draft
})
