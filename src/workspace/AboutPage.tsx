import { ArrowLeftIcon, LockIcon, WhereChip } from './icons.tsx'

interface AboutPageProps {
  onBack: () => void
}

/** What leaves this laptop and what doesn't, in order. */
const JOURNEY: { where: 'laptop' | 'cloud'; where_text: string; title: string; text: string }[] = [
  {
    where: 'laptop',
    where_text: 'On this laptop',
    title: 'Your notes are checked',
    text: 'An AI model built into Chrome (or a smaller backup model in the browser) finds names, health details, dates of birth, ID numbers and more. Code then replaces each one with a label like [EMPLOYEE_1].',
  },
  {
    where: 'laptop',
    where_text: 'On this laptop',
    title: 'You review it',
    text: 'You see every label and can keep or hide each one. A second check looks for anything that slipped through, and a guard stops the send if it finds something.',
  },
  {
    where: 'cloud',
    where_text: 'In the cloud',
    title: 'The AI writes from labels',
    text: 'Only the hidden version is sent, and only after you confirm. The cloud AI never sees who the case is about.',
  },
  {
    where: 'laptop',
    where_text: 'On this laptop',
    title: 'Real names come back',
    text: 'The draft arrives with labels in it. Your laptop swaps the real names back in. The list that links labels to names exists only in this tab’s memory.',
  },
]

/** The same facts as the code. If you change what Cloak stores, change this list too. */
const KEPT: { what: string; detail: string }[] = [
  {
    what: 'Your notes, names and the label list',
    detail: 'Nowhere. They live in this tab’s memory and are gone when you close it, press Clear all, or leave it idle.',
  },
  {
    what: 'Your saved draft',
    detail: 'Only if you press Save. It goes to your Downloads folder on this laptop, and Cloak keeps no copy.',
  },
  {
    what: 'A receipt of each send',
    detail: 'In this browser only: the exact hidden text that was sent and a fingerprint of it, so you can check it later. It has no real names, except any details you chose to keep visible.',
  },
  {
    what: 'A send log (Real AI drafting only)',
    detail: 'Counts only: how many details of each kind were hidden, whether the send was blocked, and which model ran. Never any text.',
  },
  {
    what: 'Usage counts',
    detail: 'Firebase Analytics counts events, such as “a draft was written” or “a scan finished”, with numbers and fixed words only. It never gets note text, names, file names or any hidden detail.',
  },
  {
    what: 'Your settings',
    detail: 'Choices like text size and check mode, in this browser. Nothing from a case.',
  },
]

const SAFEGUARDS: { name: string; detail: string }[] = [
  {
    name: 'Minimum necessary',
    detail: 'The cloud gets labels instead of names. A manager email sends only the work restrictions you approve, with no case notes.',
  },
  {
    name: 'Health details stay out',
    detail: 'Medical details are left out of every draft, and the manager email never includes a diagnosis.',
  },
  {
    name: 'Nothing stored by default',
    detail: 'There’s no database of cases. What you type stays in this tab’s memory.',
  },
  {
    name: 'Automatic clear',
    detail: 'After a stretch with no activity, Cloak warns you and then clears your work, like an automatic log-off. You can lengthen the time in the accessibility panel.',
  },
  {
    name: 'A record without the content',
    detail: 'The send log counts what was hidden and where each step ran. It cannot hold text, because the code rebuilds each record from fixed lists.',
  },
  {
    name: 'No leaks through the side doors',
    detail: 'Spell check is off in text boxes. Reading aloud uses only voices on this laptop. Photos are read and covered on this laptop, and only text is ever sent.',
  },
]

export function AboutPage({ onBack }: AboutPageProps) {
  return (
    <section className="card about" aria-labelledby="about-title">
      <h2 id="about-title">About Cloak</h2>
      <p className="about-lead">
        Cloak helps HR teams write case summaries, investigation write-ups and manager emails with AI, without the
        private details leaving the laptop.
      </p>
      <p className="notice warn about-demo">
        <strong>This is a demo. Use made-up data only.</strong> It was built for the Firebase AI Logic #BuildHybridAI
        hackathon and hasn’t been reviewed for use with real case files.
      </p>

      <h3>How your information moves</h3>
      <ol className="journey">
        {JOURNEY.map((item) => (
          <li key={item.title}>
            <WhereChip where={item.where}>{item.where_text}</WhereChip>
            <div>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3>What Cloak keeps</h3>
      <dl className="about-list">
        {KEPT.map((row) => (
          <div key={row.what} className="about-row">
            <dt>{row.what}</dt>
            <dd>{row.detail}</dd>
          </div>
        ))}
      </dl>

      <h3>HIPAA and FERPA</h3>
      <p>
        Cloak is built to support the habits those laws ask for: share the least you can, keep records private, and
        leave an audit trail. These are the safeguards that do that.
      </p>
      <dl className="about-list">
        {SAFEGUARDS.map((row) => (
          <div key={row.name} className="about-row">
            <dt>{row.name}</dt>
            <dd>{row.detail}</dd>
          </div>
        ))}
      </dl>
      <div className="notice info about-honest">
        <p>
          <strong>Cloak isn’t certified as HIPAA or FERPA compliant, and it hasn’t had an outside audit.</strong> No
          app is compliant by itself. Compliance depends on your contracts, your policies and how people use the tool.
        </p>
        <p>
          Before anyone uses it with real records, your privacy officer or lawyer should confirm the cloud AI provider
          is covered by the agreement your organization needs (for HIPAA, a business associate agreement), and that
          your policy allows it. Automatic hiding can also miss details, so always read the check screen.
        </p>
      </div>

      <h3>Accessibility</h3>
      <p>
        The round button at the bottom right of every screen opens the accessibility options: reading aloud, larger
        text, high contrast, roomy spacing, less motion and more time. Cloak also works with a keyboard and a screen
        reader. If something is hard to use, tell the team so it can be fixed.
      </p>

      <p className="start-note about-foot">
        <LockIcon size={15} />
        Nothing on this page is stored or sent anywhere.
      </p>

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          <ArrowLeftIcon size={18} />
          Back to my work
        </button>
      </div>
    </section>
  )
}
