import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDraftPrompt, buildManagerPrompt } from '../ai/templates.ts'
import { buildComparison, sentPayload, splitSent } from './compare.ts'
import type { ComparePiece } from './compare.ts'
import { redactNotes, writeDraft } from './fakeAi.ts'
import { outgoing } from './review.ts'
import { SAMPLE_NOTE } from './sampleNote.ts'

const plain = (pieces: ComparePiece[]) => pieces.map((p) => p.text).join('')
const idsOf = (pieces: ComparePiece[]) => pieces.flatMap((p) => (p.kind === 'text' ? [] : [p.id]))

async function investigation(kept: string[] = []) {
  const base = await redactNotes(SAMPLE_NOTE)
  const draft = await writeDraft(outgoing(base, kept), 'investigation', { approved: true })
  const comparison = buildComparison({
    notes: SAMPLE_NOTE,
    base,
    kept,
    sentText: draft.receipt.sentText,
    draftWithPlaceholders: draft.draftWithPlaceholders,
    templateId: 'investigation',
  })
  return { base, draft, comparison }
}

test('sentPayload finds the case part of the real prompts', () => {
  const notes = 'Case 1. [EMPLOYEE_1] was late.\nEmployee: not a field, just a line in the notes.'
  assert.equal(sentPayload(buildDraftPrompt(notes, 'investigation'), 'notes'), notes)
  assert.equal(sentPayload(buildDraftPrompt(notes, 'termination'), 'notes'), notes)

  const manager = buildManagerPrompt('[EMPLOYEE_1]', ['a short break every 2 hours', 'no lifting over 20 lbs'])
  assert.equal(
    sentPayload(manager, 'restrictions'),
    'Employee: [EMPLOYEE_1]\nApproved work restrictions and accommodations:\n1. a short break every 2 hours\n2. no lifting over 20 lbs',
  )
  assert.equal(sentPayload('something unexpected', 'notes'), 'something unexpected') // never hides what was sent
})

test('our instructions plus the case part are exactly the text that was sent', () => {
  const notes = 'Case 1. [EMPLOYEE_7] was late.'
  const manager = buildManagerPrompt('[EMPLOYEE_7]', ['a short break every 2 hours'])
  for (const [prompt, input] of [
    [buildDraftPrompt(notes, 'investigation'), 'notes'],
    [buildDraftPrompt(notes, 'termination'), 'notes'],
    [manager, 'restrictions'],
    ['something unexpected', 'notes'],
  ] as const) {
    const { before, payload, after } = splitSent(prompt, input)
    assert.equal(before + payload + after, prompt)
  }
  const { before, after } = splitSent(buildDraftPrompt(notes, 'investigation'), 'notes')
  assert.ok(before.includes('You are an HR writing assistant') && before.endsWith('<<<\n'))
  assert.equal(after, '\n>>>')
  assert.ok(!before.includes('[EMPLOYEE_7]')) // the instructions never hold anything from the case
})

test('the typed side is the notes exactly as typed, with every private detail marked', async () => {
  const { base, comparison } = await investigation()
  assert.equal(plain(comparison.typed), SAMPLE_NOTE)

  const marked = comparison.typed.filter((p) => p.kind === 'hidden').map((p) => p.text)
  for (const secret of ['Maria Santos', 'Maria', 'Chidi Okafor', 'EMP-40912', 'maria.santos@example.com', 'type 2 diabetes', '$68,500']) {
    assert.ok(marked.includes(secret), `${secret} should be marked`)
  }
  // The name part typed alone ("Maria") points at the same placeholder as the full name.
  const maria = Object.entries(base.map.originals).find(([, value]) => value === 'Maria Santos')?.[0]
  assert.ok(maria)
  const marias = comparison.typed.filter((p) => p.kind === 'hidden' && (p.text === 'Maria' || p.text === 'Maria Santos'))
  assert.deepEqual(idsOf(marias), [maria, maria])
})

test('the cloud side is the receipt text with placeholders only, and matches the typed side one to one', async () => {
  const { base, draft, comparison } = await investigation()
  assert.equal(plain(comparison.sent), comparison.sentPayload)
  assert.equal(comparison.sentPayload, outgoing(base, []).redactedText)
  assert.ok(draft.receipt.sentText.includes(comparison.sentPayload))

  // Not one real value is on the cloud side.
  for (const original of Object.values(base.map.originals)) {
    assert.ok(!plain(comparison.sent).includes(original), `"${original}" must not appear on the cloud side`)
  }
  for (const piece of comparison.sent) if (piece.kind === 'hidden') assert.match(piece.text, /^\[[A-Z_]+_\d+\]$/)

  // Same details, same number of times, on both sides.
  assert.deepEqual([...idsOf(comparison.typed)].sort(), [...idsOf(comparison.sent)].sort())
  assert.ok(comparison.typed.every((p) => p.kind !== 'hidden' || p.sent))
  assert.equal(comparison.restrictionsOnly, false)
})

test('a kept detail shows as kept on both sides and went as written', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const role = Object.entries(base.map.originals).find(([, value]) => value === 'the only woman')?.[0]
  assert.ok(role)
  const { comparison } = await investigation([role])

  const typedKept = comparison.typed.filter((p) => p.kind === 'kept')
  const sentKept = comparison.sent.filter((p) => p.kind === 'kept')
  assert.deepEqual(typedKept.map((p) => p.text), ['the only woman'])
  assert.deepEqual(sentKept.map((p) => p.text), ['the only woman'])
  assert.deepEqual(idsOf(typedKept), [role])
  assert.ok(!comparison.sent.some((p) => p.kind === 'hidden' && p.id === role)) // it is not a label any more
  assert.equal(plain(comparison.typed), SAMPLE_NOTE)
})

test('a manager email shows that the notes were not sent, only the approved restrictions', async () => {
  const base = await redactNotes(SAMPLE_NOTE)
  const out = outgoing(base, [])
  const maria = Object.entries(out.map.originals).find(([, value]) => value === 'Maria Santos')?.[0] ?? ''
  const draft = await writeDraft(out, 'accommodation', {
    approved: true,
    accommodation: { employee: maria, restrictions: ['a short break every 2 hours'] },
  })
  const comparison = buildComparison({
    notes: SAMPLE_NOTE,
    base,
    kept: [],
    sentText: draft.receipt.sentText,
    draftWithPlaceholders: draft.draftWithPlaceholders,
    templateId: 'accommodation',
  })

  assert.equal(comparison.restrictionsOnly, true)
  assert.equal(plain(comparison.typed), SAMPLE_NOTE)
  assert.deepEqual(idsOf(comparison.sent), [maria]) // the employee's placeholder is the only detail on the cloud side
  assert.ok(comparison.sentPayload.includes('a short break every 2 hours'))
  assert.ok(!comparison.sentPayload.includes('Maria'))

  const unsent = comparison.typed.filter((p) => p.kind === 'hidden' && !p.sent)
  assert.ok(unsent.some((p) => p.text === 'type 2 diabetes')) // the diagnosis was not sent in any form
  assert.ok(unsent.length > 5)
  assert.ok(comparison.typed.filter((p) => p.kind === 'hidden' && p.id === maria).every((p) => p.kind === 'hidden' && p.sent))
})

test('text without any hidden detail gives one plain piece on each side', async () => {
  const base = await redactNotes('Nothing private here.')
  const draft = await writeDraft(outgoing(base, []), 'investigation', { approved: true })
  const comparison = buildComparison({
    notes: 'Nothing private here.',
    base,
    kept: [],
    sentText: draft.receipt.sentText,
    draftWithPlaceholders: draft.draftWithPlaceholders,
    templateId: 'investigation',
  })
  assert.deepEqual(comparison.typed, [{ kind: 'text', text: 'Nothing private here.' }])
  assert.deepEqual(comparison.sent, [{ kind: 'text', text: 'Nothing private here.' }])
})

test('the draft that came back shows its placeholders as labels, reformatted ones too', async () => {
  const { base, draft, comparison } = await investigation()
  assert.equal(plain(comparison.back), draft.draftWithPlaceholders)
  const maria = Object.entries(base.map.originals).find(([, value]) => value === 'Maria Santos')?.[0]
  assert.ok(maria)
  assert.ok(idsOf(comparison.back).includes(maria))
  for (const piece of comparison.back) if (piece.kind !== 'text') assert.equal(piece.kind, 'hidden')
  // No real value is on this side either: it is the cloud's text, before names are restored.
  for (const original of Object.values(base.map.originals)) assert.ok(!plain(comparison.back).includes(original))

  // A placeholder the model wrote in its own style still becomes the same label; a look-alike stays text.
  const odd = buildComparison({
    notes: SAMPLE_NOTE,
    base,
    kept: [],
    sentText: draft.receipt.sentText,
    draftWithPlaceholders: `Hello [ employee 2 ], see [Table 1] and [EMPLOYEE_99].`,
    templateId: 'investigation',
  })
  const labelled = odd.back.filter((p) => p.kind === 'hidden')
  assert.deepEqual(labelled.map((p) => (p.kind === 'hidden' ? [p.id, p.text, p.label] : [])), [[maria, '[ employee 2 ]', 'NAME 2']])
  assert.equal(plain(odd.back), 'Hello [ employee 2 ], see [Table 1] and [EMPLOYEE_99].')
})
