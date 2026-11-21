// Generates FAKE HR case notes for testing redaction. Run: npm run gen:cases
//
//   node scripts/generate-cases.ts [--seed 1130] [--out data/cases]
//
// Writes set-a.json and set-b.json (60 notes each). Same seed = same files.
// Every name, number and detail is invented: emails use example.com/.org/.net, phones use
// fictional ranges, SSNs start with 9 (never issued), amounts and addresses are random.
//
// Each note has the text plus EVERY planted private item (exact text as written, with its
// type and an `entity` id that links name variants of the same person). Scoring suggestion:
// an item counts as hidden when its `text` no longer appears in the redacted output.
// `keep` lists harmless text (case numbers, event dates, policy numbers) that should stay
// visible, to catch over-redaction.
//
// Sets A and B use disjoint halves of every name pool, so B is a fair holdout for tuning on A.

import { mkdirSync, writeFileSync } from 'node:fs'
import { CATEGORIES, type Category } from '../src/ai/placeholders.ts'

type Rng = () => number
type Gender = 'f' | 'm'
type SetLabel = 'A' | 'B'
type Scenario = 'investigation' | 'accommodation' | 'termination'
type Style = 'prose' | 'bullets' | 'terse'
type Form = 'auto' | 'full' | 'first' | 'last' | 'title' | 'nick' | 'quoted' | 'sf' | 'caps' | 'initial' | 'doctor'

interface Planted {
  text: string
  type: Category
  entity: string
}

interface CaseNote {
  id: string
  scenario: Scenario
  style: Style
  text: string
  planted: Planted[]
  keep: string[]
  features: string[]
}

// ---------------------------------------------------------------------------------------------
// Random helpers (seeded, so output is reproducible)

function mulberry32(seed: number): Rng {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (r: Rng, n: number) => Math.floor(r() * n)
const pick = <T>(r: Rng, items: readonly T[]): T => items[int(r, items.length)]
const chance = (r: Rng, p: number) => r() < p

function shuffle<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Draws every item once (shuffled) before repeating, so each value is used about equally. */
function deck<T>(r: Rng, items: readonly T[]): () => T {
  let queue: T[] = []
  return () => {
    if (!queue.length) queue = shuffle(r, items)
    return queue.pop() as T
  }
}

function weighted<T>(r: Rng, options: [T, number][]): T {
  let x = r() * options.reduce((sum, [, w]) => sum + w, 0)
  for (const [value, w] of options) {
    x -= w
    if (x < 0) return value
  }
  return options[options.length - 1][0]
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const pad = (n: number, width: number) => String(n).padStart(width, '0')
const digits = (r: Rng, width: number) => pad(int(r, 10 ** width), width)
const ascii = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')

/** One realistic typo: swap two letters, drop one, or double one. Never changes the first or last letter. */
function makeTypo(s: string, r: Rng): string {
  const letters = [...s].map((ch, i) => (/\p{L}/u.test(ch) && i > 0 && i < s.length - 1 ? i : -1)).filter((i) => i >= 0)
  for (let tries = 0; letters.length && tries < 8; tries++) {
    const i = pick(r, letters)
    const op = int(r, 3)
    const out =
      op === 0 && /\p{L}/u.test(s[i + 1] ?? '')
        ? s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)
        : op === 1
          ? s.slice(0, i) + s.slice(i + 1)
          : s.slice(0, i + 1) + s.slice(i)
    if (out !== s) return out
  }
  return s
}

// ---------------------------------------------------------------------------------------------
// Names. Entries are "Name/Nickname/gender". Arrays alternate f,f,m,m so each set's half gets both.

interface Culture {
  id: string
  main: boolean
  order: 'western' | 'eastern' // eastern = family name first (Vietnamese)
  first: string[]
  last: string[]
  middle?: Record<Gender, string>
  phone?: string // country prefix for international formats
}

const CULTURES: Culture[] = [
  {
    id: 'filipino', main: true, order: 'western', phone: '+63 917',
    first: ['Jocelyn/Joy/f', 'Marites/Tess/f', 'Jericho/Jek/m', 'Reynaldo/Rey/m', 'Cristina/Tina/f', 'Ligaya/Gay/f', 'Joselito/Lito/m', 'Edgardo/Egay/m', 'Rowena/Weng/f', 'Maricel/Cel/f', 'Ramon/Mon/m', 'Dionisio/Nonoy/m', 'Aileen//f', 'Liezl//f', 'Bienvenido/Ben/m', 'Rolando/Rolly/m'],
    last: ['Dela Cruz', 'Bautista', 'Villanueva', 'Macaraeg', 'Dimaculangan', 'Pangilinan', 'Magsaysay', 'Tolentino', 'Evangelista', 'Dizon', 'Ocampo', 'Manalo', 'Lacson', 'Cabading', 'Abueva', 'Sarmiento'],
  },
  {
    id: 'nigerian', main: true, order: 'western', phone: '+234 803',
    first: ['Chidinma/Chi/f', 'Ngozi//f', 'Chukwuemeka/Emeka/m', 'Babatunde/Tunde/m', 'Folasade/Sade/f', 'Adaeze/Ada/f', 'Ifeanyi/Ify/m', 'Olumide/Mide/m', 'Yetunde/Yetty/f', 'Amaka//f', 'Obinna//m', 'Kayode/Kay/m', 'Titilayo/Titi/f', 'Oluwaseun/Seun/f', 'Segun//m', 'Uchenna/Uche/m'],
    last: ['Okafor', 'Adeyemi', 'Nwosu', 'Balogun', 'Eze', 'Ogunleye', 'Olawale', 'Chukwu', 'Abubakar', 'Onyeama', 'Adebayo', 'Ibekwe', 'Okonkwo', 'Obi', 'Ojo', 'Akinyemi'],
  },
  {
    id: 'vietnamese', main: true, order: 'eastern', phone: '+84 90', middle: { f: 'Thị', m: 'Văn' },
    first: ['Lan//f', 'Hương/Holly/f', 'Tuấn/Tony/m', 'Minh/Mike/m', 'Thảo//f', 'Trâm//f', 'Đức//m', 'Khoa//m', 'Linh/Lynn/f', 'Mai//f', 'Lộc//m', 'Hải//m', 'Hạnh//f', 'Yến//f', 'Quân//m', 'Bảo/Bobby/m'],
    last: ['Nguyễn', 'Trần', 'Lương', 'Phạm', 'Hoàng', 'Võ', 'Đặng', 'Bùi', 'Đào', 'Ngô', 'Dương', 'Lâm', 'Phan', 'Trương', 'Đinh', 'Huỳnh'],
  },
  {
    id: 'latino', main: true, order: 'western', phone: '+52 55',
    first: ['María Guadalupe/Lupita/f', 'Ximena//f', 'Jesús/Chuy/m', 'Ignacio/Nacho/m', 'Yesenia/Yesi/f', 'Esmeralda/Esme/f', 'Francisco/Paco/m', 'Cuauhtémoc/Temo/m', 'Marisol//f', 'Daniela/Dani/f', 'Joaquín/Quino/m', 'Ernesto/Neto/m', 'Altagracia/Alta/f', 'Xóchitl//f', 'Rodrigo/Rodri/m', 'Ulises//m'],
    last: ['Hernández', 'Villalobos', 'Ceballos', 'Quintanilla', 'Zamora', 'Ochoa', 'Rivas', 'Montoya', 'Barragán', 'Contreras', 'Escobedo', 'Fuentes', 'Gallegos', 'Ibarra', 'Paredes', 'Solís'],
  },
  {
    id: 'south-asian', main: true, order: 'western', phone: '+91 98',
    first: ['Priyanka/Pri/f', 'Lakshmi//f', 'Rajesh/Raj/m', 'Venkatesh/Venky/m', 'Anjali/Anju/f', 'Ayesha//f', 'Gurpreet/Preet/m', 'Imran//m', 'Kavitha/Kavi/f', 'Deepika/Deepi/f', 'Sandeep/Sandy/m', 'Harish/Hari/m', 'Sunita//f', 'Meenakshi/Meena/f', 'Suresh/Suri/m', 'Arjun//m'],
    last: ['Venkataraman', 'Subramaniam', 'Chaudhry', 'Kulkarni', 'Banerjee', 'Gill', 'Siddiqui', 'Reddy', 'Mukherjee', 'Pillai', 'Dhillon', 'Ansari', 'Iyer', 'Menon', 'Bhatt', 'Naqvi'],
  },
  {
    id: 'anglo', main: false, order: 'western',
    first: ['Kimberly/Kimmie/f', 'Heather//f', 'Gregory/Greg/m', 'Dwayne//m', 'Tammy//f', 'Courtney//f', 'Russell/Russ/m', 'Wade//m'],
    last: ['Whitaker', 'Pruitt', 'Hargrove', 'Danforth', 'Linwood', 'Ketterman', 'Ashby', 'Prescott'],
  },
  {
    id: 'korean', main: false, order: 'western', phone: '+82 10',
    first: ['Soo-jin/Sue/f', 'Hye-won//f', 'Min-jun/MJ/m', 'Dong-hyun/Dong/m', 'Eun-ji//f', 'Yuna//f', 'Seung-ho//m', 'Tae-yang/Ty/m'],
    last: ['Park', 'Jeong', 'Yoon', 'Choi', 'Kang', 'Seo', 'Baek', 'Shin'],
  },
  {
    id: 'arab', main: false, order: 'western', phone: '+971 50',
    first: ['Layla//f', 'Noor//f', 'Khalid//m', 'Tariq//m', 'Samira//f', 'Dalia//f', 'Omar//m', 'Yusuf//m'],
    last: ['Haddad', 'Nasser', 'Khoury', 'Mansour', 'Aziz', 'Farouk', 'Saleh', 'Qureshi'],
  },
  {
    id: 'eastern-european', main: false, order: 'western', phone: '+48 600',
    first: ['Agnieszka/Aga/f', 'Oksana//f', 'Bogdan//m', 'Tomasz/Tom/m', 'Katarzyna/Kasia/f', 'Halyna//f', 'Mykola//m', 'Piotr//m'],
    last: ['Kowalczyk', 'Shevchenko', 'Nowak', 'Bondarenko', 'Wójcik', 'Kravchuk', 'Zielinski', 'Petrenko'],
  },
  {
    id: 'chinese', main: false, order: 'western', phone: '+86 138',
    first: ['Xiu-ying//f', 'Jia-li/Jia/f', 'Wei//m', 'Zhi-hao/Hao/m', 'Yan//f', 'Qing//f', 'Rui//m', 'Cheng//m'],
    last: ['Wang', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu'],
  },
]

const half = <T>(items: T[], set: SetLabel) => items.filter((_, i) => i % 2 === (set === 'A' ? 0 : 1))

interface Person {
  key: string
  first: string
  last: string
  middle?: string
  nick?: string
  gender: Gender
  culture: Culture
  plain: boolean // write without diacritics ("Nguyen" for "Nguyễn")
}

function makePerson(r: Rng, set: SetLabel, culture: Culture, key: string, gender: Gender, taken: Person[]): Person {
  const firsts = half(culture.first, set).map((s) => s.split('/')).filter((f) => f[2] === gender)
  const lasts = half(culture.last, set)
  for (let tries = 0; ; tries++) {
    const [first, nick] = pick(r, firsts)
    const last = pick(r, lasts)
    if (tries < 30 && taken.some((t) => t.first === first || t.last === last)) continue
    return {
      key, first, last, nick: nick || undefined, gender, culture,
      middle: culture.middle?.[gender],
      plain: ascii(first + last) !== first + last && chance(r, 0.3),
    }
  }
}

const fix = (p: Person, s: string) => (p.plain ? ascii(s) : s)
const givenName = (p: Person) => (p.culture.order === 'eastern' ? p.first : p.first.split(' ')[0])
const fullName = (p: Person) =>
  p.culture.order === 'eastern' ? [p.last, p.middle, p.first].filter(Boolean).join(' ') : `${p.first} ${p.last}`

interface Pron { s: string; o: string; p: string; S: string; P: string }
const PRON: Record<Gender, Pron> = {
  f: { s: 'she', o: 'her', p: 'her', S: 'She', P: 'Her' },
  m: { s: 'he', o: 'him', p: 'his', S: 'He', P: 'His' },
}

// ---------------------------------------------------------------------------------------------
// Content pools

const MEDICAL = [
  'type 2 diabetes', 'gestational diabetes', 'stage II breast cancer', 'post-partum depression', 'bipolar II disorder',
  'HIV-positive status', 'epilepsy', 'sickle cell disease', 'lupus', 'generalized anxiety disorder', 'ADHD',
  'chronic kidney disease (dialysis three times a week)', 'hypertension', 'sciatica', 'a torn ACL (surgery scheduled)',
  'pregnancy (due in March)', 'multiple sclerosis', 'major depressive disorder', 'chemotherapy', 'an insulin pump',
  'migraines', 'a herniated disc', 'sertraline 50 mg daily', 'PTSD', 'celiac disease', 'carpal tunnel syndrome',
  'asthma', "Crohn's disease",
]

const JOBS = ['forklift lead', 'pharmacy technician', 'payroll analyst', 'dispatcher', 'line cook', 'ICU nurse', 'QA inspector', 'CNC machinist', 'claims adjuster', 'front-desk coordinator', 'loan officer', 'delivery driver', 'lab technician', 'sous chef', 'receiving clerk', 'safety coordinator']
const SHIFTS = ['night', 'weekend', 'swing', 'early-morning']
const DESCRIPTORS = ['woman', 'Filipino', 'Vietnamese-speaking', 'Spanish-speaking', 'Nigerian-born', 'Punjabi-speaking']
const SUPERLATIVES = ['youngest', 'oldest', 'newest', 'longest-serving']
const UNITS = ['on the night warehouse crew', 'at the Cebu branch', 'on Line 3', 'in the ICU', 'at the Tulsa depot', 'in cold storage', 'on the weekend loading dock', 'in Building C']
const CREWS = ['the night warehouse crew', 'the weekend dock team', 'Line 3 packaging']
const ORIGINS = ['Lagos', 'Cebu', 'Hanoi', 'Guadalajara', 'Chennai', 'Tulsa']
const SITES = ['Tulsa depot', 'Cebu branch', 'Building C annex']
const DEPARTMENTS = ['the night warehouse crew', 'the Cebu branch', 'the Line 3 packaging team', 'the Building C loading dock', 'the Tulsa depot', 'the cold-storage unit', 'the weekend dispatch team']

const STREETS = ['Maple Hollow Rd', 'Calle Luna', 'Mabini St.', 'Orchard Ln', 'Rizal Ave.', 'Ashgrove Dr', 'Banyan Ct', 'Unity Blvd', 'Harbor View Way', 'Camia St.']
const CITIES = ['Quezon City', 'Cebu City', 'Lagos', 'Houston', 'San Jose', 'Tulsa', 'Fresno', 'Mesa']
const UNIT_FORMS = ['Apt 4B', 'Unit 12', '#305', 'Apt 17']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const below100 = (n: number) => (n < 20 ? ONES[n] : n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)])
const below1000 = (n: number) =>
  [n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred` : '', n % 100 ? below100(n % 100) : ''].filter(Boolean).join(' ')
const words = (n: number) =>
  [n >= 1000 ? `${below1000(Math.floor(n / 1000))} thousand` : '', n % 1000 ? below1000(n % 1000) : ''].filter(Boolean).join(' ')

const money = (n: number) => n.toLocaleString('en-US')
const trimK = (n: number) => String(Math.round(n * 10) / 10)

/** 14 ways to write pay. Index cycles through a shuffled deck so every format shows up. */
const SALARY_FORMATS = 14
function salaryText(format: number, r: Rng): string {
  const usd = 30000 + 500 * int(r, 240)
  switch (format) {
    case 0: return `$${money(usd)}`
    case 1: return `$${usd}`
    case 2: return `${trimK(usd / 1000)}k`
    case 3: return `$${trimK(usd / 1000)}K`
    case 4: return `USD ${money(usd)}.00`
    case 5: return `${words(usd)} dollars`
    case 6: return `$${15 + int(r, 40)}${chance(r, 0.5) ? '.50' : '.00'}/hr`
    case 7: return `PHP ${money(20000 + 1000 * int(r, 60))}`
    case 8: return `₱${money(20000 + 1000 * int(r, 60))}/month`
    case 9: return `₦${money(150000 + 10000 * int(r, 60))}`
    case 10: return `₹${4 + int(r, 16) / 2} lakh`
    case 11: return `£${money(28000 + 1000 * int(r, 40))}`
    case 12: return `${trimK((usd / 12) / 1000)}k/mo`
    default: return `$${money(900 + 25 * int(r, 40))}/wk`
  }
}

// ---------------------------------------------------------------------------------------------
// Per-note builder: every private value goes through plant(), so the answer key can't drift from the text.

interface Decks {
  salary: () => number
  medical: () => string
  role: () => number
  empId: () => number
  otherId: () => number
  dob: () => number
}

function makeDecks(r: Rng): Decks {
  return {
    salary: deck(r, Array.from({ length: SALARY_FORMATS }, (_, i) => i)),
    medical: deck(r, MEDICAL),
    role: deck(r, [0, 1, 2, 3, 4, 5]),
    empId: deck(r, [0, 1, 2, 3]),
    otherId: deck(r, [0, 1, 2, 3, 4]),
    dob: deck(r, [0, 1, 2, 3]),
  }
}

class Ctx {
  r: Rng
  decks: Decks
  typos: number
  planted: Planted[] = []
  keep: string[] = []
  features = new Set<string>()
  persons: Person[] = []
  emp!: Person
  sup!: Person
  wit!: Person
  doc!: Person
  private counters: Record<string, number> = {}
  private mentions = new Map<string, number>()
  private roles = new Map<string, string>()

  constructor(r: Rng, decks: Decks, typos: number) {
    this.r = r
    this.decks = decks
    this.typos = typos
  }

  plant(text: string, type: Category, entity: string): string {
    if (!this.planted.some((p) => p.text === text && p.type === type)) this.planted.push({ text, type, entity })
    return text
  }

  /** Plants a non-person item with its own entity id. */
  item(type: Category, text: string, label: string): string {
    this.counters[label] = (this.counters[label] ?? 0) + 1
    return this.plant(text, type, `${label}:${this.counters[label]}`)
  }

  keepText(text: string): string {
    if (!this.keep.includes(text)) this.keep.push(text)
    return text
  }

  /** Maybe misspells `s` (uses up the note's typo budget). */
  typo(s: string): string {
    if (this.typos > 0 && chance(this.r, 0.35)) {
      const t = makeTypo(s, this.r)
      if (t !== s) {
        this.typos--
        this.features.add('typo')
        return t
      }
    }
    return s
  }

  /** A person as the note refers to them: full name, first name, nickname, "Ms. Last", etc. */
  m(p: Person, form: Form = 'auto'): string {
    const seen = this.mentions.get(p.key) ?? 0
    this.mentions.set(p.key, seen + 1)
    if (!this.persons.includes(p)) this.persons.push(p)
    let f = form
    if (f === 'auto') {
      f =
        seen === 0
          ? weighted<Form>(this.r, [['full', 1], ['quoted', p.nick && p.culture.order === 'western' ? 0.3 : 0], ['nick', p.nick ? 0.15 : 0]])
          : weighted<Form>(this.r, [['first', 0.3], ['title', 0.2], ['full', 0.15], ['last', 0.1], ['initial', 0.05], ['nick', p.nick ? 0.5 : 0]])
    }
    const put = (s: string) => this.plant(s, 'PERSON', `person:${p.key}`)
    const say = (s: string) => this.typo(fix(p, s))
    const title = p.gender === 'f' ? 'Ms.' : 'Mr.'
    switch (f) {
      case 'last': return put(say(p.last))
      case 'first': return put(say(givenName(p)))
      case 'title': return `${title} ${put(say(p.culture.order === 'eastern' && chance(this.r, 0.5) ? givenName(p) : p.last))}`
      case 'doctor': return `Dr. ${put(say(p.last))}`
      case 'sf': return put(say(`${p.last}, ${givenName(p)}`))
      case 'caps':
        this.features.add('caps')
        return put(fix(p, `${p.last}, ${givenName(p)}`).toUpperCase())
      case 'initial': return put(`${fix(p, givenName(p))[0]}. ${fix(p, p.last)}`)
      case 'quoted': // Jocelyn "Joy" Bautista
        if (!p.nick) return put(say(fullName(p)))
        this.features.add('nickname')
        return put(`${say(givenName(p))} "${say(p.nick)}" ${say(p.last)}`)
      case 'nick':
        if (!p.nick) return put(say(givenName(p)))
        this.features.add('nickname')
        return put(say(p.nick))
      default: return put(say(fullName(p)))
    }
  }

  /** Indirect identifier for a person ("the only night-shift forklift lead"); same phrase every time. */
  role(p: Person, capital = false): string {
    let base = this.roles.get(p.key)
    if (!base) {
      const r = this.r
      const job = pick(r, JOBS)
      const unit = pick(r, UNITS)
      base = [
        `the only ${pick(r, SHIFTS)}-shift ${job}`,
        `the only ${pick(r, DESCRIPTORS)} ${job} ${unit}`,
        `the ${pick(r, SUPERLATIVES)} ${job} ${unit}`,
        `the only ${pick(r, ['woman', 'Filipino worker', 'Spanish speaker'])} on ${pick(r, CREWS)}`,
        `the new hire from ${pick(r, ORIGINS)}`,
        `the sole ${job} at the ${pick(r, SITES)}`,
      ][this.decks.role()]
      this.roles.set(p.key, base)
      this.features.add('indirect-id')
    }
    return this.plant(capital ? capFirst(base) : base, 'ROLE', `role:${p.key}`)
  }

  dept(): string {
    return this.item('DEPARTMENT', pick(this.r, DEPARTMENTS), 'dept')
  }

  empId(): string {
    const n = 10000 + int(this.r, 90000)
    switch (this.decks.empId()) {
      case 0: return this.item('EMPLOYEE_ID', `EMP-${n}`, 'empid')
      case 1: return this.item('EMPLOYEE_ID', `E${n}`, 'empid')
      case 2: return `employee no. ${this.item('EMPLOYEE_ID', String(n), 'empid')}`
      default: return `badge #${this.item('EMPLOYEE_ID', String(n), 'empid')}`
    }
  }

  salary(): string {
    return this.item('SALARY', salaryText(this.decks.salary(), this.r), 'salary')
  }

  medical(): string {
    return this.item('MEDICAL', this.typo(this.decks.medical()), 'medical')
  }

  email(p: Person): string {
    const f = ascii(givenName(p)).toLowerCase().replace(/[^a-z]/g, '')
    const l = ascii(p.last).toLowerCase().replace(/[^a-z]/g, '')
    const local = pick(this.r, [`${f}.${l}`, `${f[0]}${l}`, `${(p.nick ? ascii(p.nick).toLowerCase() : f).replace(/[^a-z]/g, '')}${int(this.r, 90) + 10}`])
    return this.item('EMAIL', `${local}@example.${pick(this.r, ['com', 'org', 'net'])}`, 'email')
  }

  phone(p: Person): string {
    const tail = `01${pad(int(this.r, 100), 2)}`
    const intl = p.culture.phone && chance(this.r, 0.3)
    const text = intl
      ? `${p.culture.phone} 000 ${tail}` // the 000 block is never assigned
      : pick(this.r, [`(555) 555-${tail}`, `555-555-${tail}`, `555.555.${tail}`, `+1 555 555 ${tail}`])
    return this.item('PHONE', text, 'phone')
  }

  address(): string {
    const unit = chance(this.r, 0.5) ? `${pick(this.r, UNIT_FORMS)}, ` : ''
    return this.item('ADDRESS', `${10 + int(this.r, 4990)} ${pick(this.r, STREETS)}, ${unit}${pick(this.r, CITIES)}`, 'address')
  }

  /** A full sentence about an ID that isn't an employee number (fake SSNs start with 9). */
  otherIdLine(): string {
    const r = this.r
    const ssn = `9${digits(r, 2)}-${digits(r, 2)}-${digits(r, 4)}`
    switch (this.decks.otherId()) {
      case 0: return `SSN on file: ${this.item('OTHER_ID', ssn, 'ssn')}.`
      case 1: return `SSN ${this.item('OTHER_ID', ssn.replace(/-/g, ' '), 'ssn')} was used for the I-9.`
      case 2: return `Payroll has SSN ${this.item('OTHER_ID', ssn.replace(/-/g, ''), 'ssn')}.`
      case 3: return `Passport no. ${this.item('OTHER_ID', `P${digits(r, 7)}`, 'passport')} was copied for the file.`
      default: return `Work permit no. ${this.item('OTHER_ID', `A${digits(r, 8)}`, 'permit')} expires next year.`
    }
  }

  dobLine(P: Pron): string {
    const r = this.r
    const year = 1960 + int(r, 44)
    const month = int(r, 12)
    const day = 1 + int(r, 28)
    const age = 2026 - year
    switch (this.decks.dob()) {
      case 0: return `DOB: ${this.item('DATE_OF_BIRTH', `${pad(month + 1, 2)}/${pad(day, 2)}/${year}`, 'dob')}.`
      case 1: return `${P.S} was born ${this.item('DATE_OF_BIRTH', `${day} ${MONTH_NAMES[month]} ${year}`, 'dob')}.`
      case 2: return `${P.S} is ${this.item('DATE_OF_BIRTH', `${age} years old`, 'dob')}.`
      default: return `${P.S} is ${this.item('DATE_OF_BIRTH', `aged ${age}`, 'dob')}.`
    }
  }

  /** An event date. Harmless, so it goes in `keep` (it must NOT be hidden). */
  date(): string {
    return this.keepText(`${pick(this.r, MONTHS)} ${1 + int(this.r, 28)}`)
  }

  policy(): string {
    return this.keepText(`Policy ${1 + int(this.r, 9)}.${1 + int(this.r, 6)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios. Each returns sentences; closures keep unused branches from planting anything.

const run = <T>(r: Rng, options: (() => T)[]): T => pick(r, options)()

function contactLine(c: Ctx, p: Person, P: Pron): string {
  return run(c.r, [
    () => `${P.S} can be reached at ${c.email(p)} or ${c.phone(p)}.`,
    () => `Home address on file: ${c.address()}. Cell: ${c.phone(p)}.`,
    () => `Personal email ${c.email(p)}, phone ${c.phone(p)}.`,
    () => `Mailing address is ${c.address()}.`,
  ])
}

function payLine(c: Ctx, P: Pron): string {
  return run(c.r, [
    () => `Salary: ${c.salary()}.`,
    () => `Payroll shows pay of ${c.salary()}.`,
    () => `${P.S} told HR ${P.s} earns ${c.salary()} and is paid late some months.`,
    () => `Current pay is ${c.salary()}.`,
  ])
}

function medicalLine(c: Ctx, P: Pron): string {
  return run(c.r, [
    () => `Medical info on file: ${c.medical()}.`,
    () => `${P.S} disclosed ${c.medical()} and asked for some flexibility.`,
    () => `The doctor's note mentions ${c.medical()}.`,
    () => `HR was told about ${c.medical()}.`,
  ])
}

/** Guarantees the pronoun / "the employee" references a real note would have. */
function referenceLine(c: Ctx, P: Pron): string {
  return run(c.r, [
    () => 'The employee asked that this stay confidential.',
    () => `${P.S} does not want ${P.p} manager told yet.`,
    () => `HR received the report because ${P.s} came in person.`,
    () => 'The employee has not been told who else is being interviewed.',
  ])
}

function investigation(c: Ctx): string[] {
  const { emp, sup, wit } = c
  const P = PRON[emp.gender]
  const incident = run(c.r, [
    () => `mocked ${P.p} accent in the ${c.date()} team meeting`,
    () => `kept assigning ${P.o} the closing shift without notice`,
    () => `did not pay ${P.p} overtime for the last three pay periods`,
    () => `cut ${P.p} hours after ${P.s} raised a safety concern`,
    () => `sent ${P.o} unwelcome messages after hours`,
    () => `left ${P.o} out of the ${c.date()} planning meeting on purpose`,
    () => `made comments about ${P.p} family leave in front of the crew`,
  ])
  const supRef = run(c.r, [() => `${P.p} supervisor, ${c.m(sup)},`, () => c.m(sup), () => c.m(sup, 'title')])
  const parts = [
    run(c.r, [
      () => `${c.m(emp)} (${c.empId()}) reported that ${supRef} ${incident}.`,
      () => `On ${c.date()}, ${c.m(emp)} told HR that ${supRef} ${incident}.`,
      () => `${c.role(emp, true)} told HR that ${supRef} ${incident}. Intake record: ${c.m(emp, 'sf')} (${c.empId()}).`,
    ]),
    run(c.r, [
      () => `Witness: ${c.m(wit)}, ${c.role(wit)}.`,
      () => `${c.m(wit)} (${c.dept()}) says ${PRON[wit.gender].s} saw part of it.`,
      () => `A coworker, ${c.m(wit, wit.nick ? 'nick' : 'first')}, was nearby and heard it.`,
    ]),
  ]
  if (chance(c.r, 0.5)) parts.push(`${P.S} is ${c.role(emp)}.`)
  if (chance(c.r, 0.5)) parts.push(`${P.S} works with ${c.dept()}.`)
  if (chance(c.r, 0.7)) parts.push(contactLine(c, emp, P))
  if (chance(c.r, 0.7)) parts.push(payLine(c, P))
  if (chance(c.r, 0.35)) parts.push(medicalLine(c, P))
  if (chance(c.r, 0.2)) parts.push(c.dobLine(P))
  if (chance(c.r, 0.25)) parts.push(c.otherIdLine())
  parts.push(referenceLine(c, P))
  parts.push(`Next: interview ${c.m(sup, 'title')} and ${c.m(wit)}; review ${c.policy()}.`)
  return parts
}

function accommodation(c: Ctx): string[] {
  const { emp, sup } = c
  const P = PRON[emp.gender]
  const ask = pick(c.r, ['a reduced lifting limit', 'a short break every 2 hours', 'remote work two days a week', 'a stool at the packing station', 'a later start time', 'an ergonomic keyboard', 'a parking space near the entrance'])
  const parts = [
    run(c.r, [
      () => `${c.m(emp)} (${c.empId()}) asked for ${ask} because of ${c.medical()}.`,
      () => `${c.role(emp, true)} requested ${ask}. Diagnosis in the note: ${c.medical()}. Name on the form: ${c.m(emp, 'sf')}.`,
      () => `Accommodation request from ${c.m(emp)}: ${ask}. ${P.S} explained ${P.s} is dealing with ${c.medical()}.`,
    ]),
    `The doctor's note from ${c.m(c.doc, 'doctor')} dated ${c.date()} supports the request.`,
    run(c.r, [
      () => `${c.m(sup)} is ${P.p} manager and should only hear about the restrictions.`,
      () => `${c.m(sup, 'title')} was told only the work restrictions.`,
    ]),
  ]
  if (chance(c.r, 0.5)) parts.push(`${P.S} is ${c.role(emp)}.`)
  if (chance(c.r, 0.4)) parts.push(`${P.S} works with ${c.dept()}.`)
  if (chance(c.r, 0.7)) parts.push(contactLine(c, emp, P))
  if (chance(c.r, 0.7)) parts.push(payLine(c, P))
  if (chance(c.r, 0.2)) parts.push(c.dobLine(P))
  if (chance(c.r, 0.2)) parts.push(c.otherIdLine())
  parts.push(referenceLine(c, P))
  parts.push(`Interactive process meeting set for ${c.date()}; see ${c.policy()} on accommodation.`)
  return parts
}

function termination(c: Ctx): string[] {
  const { emp, sup } = c
  const P = PRON[emp.gender]
  const reason = run(c.r, [
    () => `${P.S} had ${3 + int(c.r, 6)} unexcused absences since ${pick(c.r, MONTH_NAMES)}`,
    () => `${P.S} falsified timecards on ${c.date()}`,
    () => `${P.S} did not meet the targets in the performance plan`,
    () => `${P.P} position is being eliminated in the restructuring`,
  ])
  const parts = [
    run(c.r, [
      () => `Termination review for ${c.m(emp)} (${c.empId()}), ${c.role(emp)}.`,
      () => `${c.m(emp, 'sf')} (${c.empId()}) is being considered for termination.`,
    ]),
    `${reason}.`,
    `Recommended by ${c.m(sup)}.`,
    `Severance offered: ${c.salary()}.`,
  ]
  if (chance(c.r, 0.5)) parts.push(`${P.S} works with ${c.dept()}.`)
  if (chance(c.r, 0.55)) parts.push(`${P.S} had a leave request on file for ${c.medical()}, so legal should review first.`)
  if (chance(c.r, 0.6)) parts.push(`Send the letter to ${c.address()} and ${c.email(emp)}.`)
  if (chance(c.r, 0.5)) parts.push(payLine(c, P))
  if (chance(c.r, 0.2)) parts.push(c.dobLine(P))
  if (chance(c.r, 0.25)) parts.push(c.otherIdLine())
  parts.push(referenceLine(c, P))
  parts.push(`Last day to be confirmed after review of ${c.policy()}.`)
  return parts
}

// Common misspellings sprinkled over ordinary words (names and medical terms get typos separately).
const PROSE_TYPOS: [RegExp, string][] = [
  [/\breceived\b/, 'recieved'], [/\bbecause\b/, 'becuase'], [/\baccommodation\b/, 'accomodation'],
  [/\bdiscrimination\b/, 'discriminaton'], [/\bemployee\b/, 'employe'], [/\bconfidential\b/, 'confidentail'],
  [/\bovertime\b/, 'overtiem'], [/\bperformance\b/, 'performence'],
]
const TERSE: [RegExp, string][] = [
  [/\bemployee\b/g, 'EE'], [/\bmeeting\b/g, 'mtg'], [/\bsupervisor\b/g, 'sup.'], [/\bmanager\b/g, 'mgr'],
  [/\bbecause\b/g, 'b/c'], [/\bwith\b/g, 'w/'],
]

// ---------------------------------------------------------------------------------------------
// Assembly and checks

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Throws if the key is wrong: a planted item missing from the text, or a person's name left unplanted. */
function validate(note: CaseNote, persons: Person[]) {
  const fail = (msg: string): never => {
    throw new Error(`${note.id}: ${msg}\n${note.text}`)
  }
  for (const p of note.planted) {
    if (!CATEGORIES.includes(p.type)) fail(`bad type ${p.type}`)
    if (!p.text || !note.text.includes(p.text)) fail(`planted text not in note: "${p.text}"`)
  }
  for (const k of note.keep) if (!note.text.includes(k)) fail(`keep text not in note: "${k}"`)
  if (!/\b(she|he|her|his|him)\b/i.test(note.text)) fail('no pronoun reference')

  // Every spot where a person's name appears must be covered by a planted item.
  const covered: [number, number][] = []
  for (const p of note.planted) {
    for (let at = note.text.indexOf(p.text); at >= 0; at = note.text.indexOf(p.text, at + 1)) covered.push([at, at + p.text.length])
  }
  const tokens = new Set<string>()
  for (const p of persons) {
    for (const raw of [p.first, p.last, p.nick ?? '']) {
      for (const part of raw.split(/\s+/)) { // hyphenated names ("Min-jun") stay whole
        if (part.length >= 3) { tokens.add(part); tokens.add(ascii(part)) }
      }
    }
  }
  for (const token of tokens) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(token)}(?![\\p{L}\\p{N}])`, 'giu')
    for (const m of note.text.matchAll(re)) {
      const at = m.index
      if (!covered.some(([a, b]) => at >= a && at + m[0].length <= b)) fail(`name "${m[0]}" is in the text but not planted`)
    }
  }
}

const SCENARIO_FN: Record<Scenario, (c: Ctx) => string[]> = { investigation, accommodation, termination }

function buildNote(r: Rng, set: SetLabel, index: number, scenario: Scenario, culture: Culture, decks: Decks): CaseNote {
  const c = new Ctx(r, decks, chance(r, 0.45) ? 1 + (chance(r, 0.3) ? 1 : 0) : 0)
  const people: Person[] = []
  const make = (key: string, cult: Culture, gender?: Gender) => {
    const p = makePerson(r, set, cult, key, gender ?? pick(r, ['f', 'm'] as Gender[]), people)
    people.push(p)
    return p
  }
  c.emp = make('emp', culture)
  c.sup = make('sup', pick(r, CULTURES))
  c.wit = make('wit', pick(r, CULTURES))
  c.doc = make('doc', pick(r, CULTURES))

  const style = weighted<Style>(r, [['prose', 0.5], ['bullets', 0.3], ['terse', 0.2]])
  const caseNo = c.keepText(`Case ${24 + int(r, 3)}-${100 + int(r, 900)}`)
  const lead = style === 'bullets' && chance(r, 0.5) ? [`Employee: ${c.m(c.emp, 'caps')}`] : []
  const parts = [...lead, ...SCENARIO_FN[scenario](c)]

  let text: string
  if (style === 'bullets') text = `${caseNo} notes:\n${parts.map((p) => `- ${p}`).join('\n')}`
  else if (style === 'terse') text = [`${caseNo} -`, ...parts].join(' ').replace(/\s+/g, ' ')
  else text = [`${caseNo}.`, ...parts].join(' ')

  if (style === 'terse') for (const [re, to] of TERSE) text = text.replace(re, to)
  if (chance(r, 0.35)) {
    for (const [re, to] of shuffle(r, PROSE_TYPOS).slice(0, 2)) {
      if (re.test(text)) {
        text = text.replace(re, to)
        c.features.add('prose-typo')
      }
    }
  }

  const note: CaseNote = {
    id: `${set}${pad(index + 1, 3)}`,
    scenario,
    style,
    text,
    planted: c.planted,
    keep: c.keep,
    features: [
      ...new Set([`culture:${culture.id}`, ...c.persons.map((p) => `culture:${p.culture.id}`), ...c.features]),
    ].sort(),
  }
  validate(note, c.persons)
  return note
}

function generateSet(set: SetLabel, seed: number, count: number): CaseNote[] {
  const r = mulberry32(seed)
  const decks = makeDecks(r)
  // Balanced, independently shuffled sequences, so scenario and culture aren't tied together.
  const scenarios = shuffle(r, Array.from({ length: count }, (_, i) => (['investigation', 'accommodation', 'termination'] as Scenario[])[i % 3]))
  const slots = CULTURES.flatMap((cu) => (cu.main ? [cu, cu] : [cu]))
  const cultures = shuffle(r, Array.from({ length: count }, (_, i) => slots[i % slots.length]))
  return Array.from({ length: count }, (_, i) => buildNote(r, set, i, scenarios[i], cultures[i], decks))
}

// ---------------------------------------------------------------------------------------------
// Checks across sets, stats, and output

function checkSetsAreDisjoint(a: CaseNote[], b: CaseNote[]) {
  const names = (notes: CaseNote[]) =>
    new Set(notes.flatMap((n) => n.planted.filter((p) => p.type === 'PERSON').map((p) => ascii(p.text).toLowerCase())))
  const inA = names(a)
  const shared = [...names(b)].filter((n) => inA.has(n))
  if (shared.length) throw new Error(`Sets A and B share person text: ${shared.join(', ')}`)
}

/** Fails loudly if a set doesn't contain what the test plan promises. */
function checkCoverage(label: string, notes: CaseNote[]) {
  const count = (name: string) => notes.filter((n) => n.features.includes(name)).length
  const planted = (type: Category) => notes.flatMap((n) => n.planted).filter((p) => p.type === type).length
  const problems: string[] = []
  const need = (ok: boolean, msg: string) => { if (!ok) problems.push(msg) }
  for (const cu of CULTURES) need(count(`culture:${cu.id}`) >= 6, `culture ${cu.id} in fewer than 6 notes`)
  need(count('nickname') >= 15, `only ${count('nickname')} notes with a nickname`)
  need(count('typo') >= 12, `only ${count('typo')} notes with a name/medical typo`)
  need(count('indirect-id') >= 30, `only ${count('indirect-id')} notes with an indirect identifier`)
  need(planted('SALARY') >= SALARY_FORMATS * 3, `only ${planted('SALARY')} salaries (need 3 per format)`)
  need(new Set(notes.flatMap((n) => n.planted).filter((p) => p.type === 'MEDICAL').map((p) => p.text)).size >= 20, 'fewer than 20 distinct medical items')
  if (problems.length) throw new Error(`Set ${label} coverage: ${problems.join('; ')}`)
}

function stats(label: string, notes: CaseNote[]) {
  const count = (pred: (n: CaseNote) => boolean) => notes.filter(pred).length
  const features = (name: string) => count((n) => n.features.includes(name))
  const byType: Record<string, number> = {}
  for (const n of notes) for (const p of n.planted) byType[p.type] = (byType[p.type] ?? 0) + 1
  console.log(`\nSet ${label}: ${notes.length} notes, ${notes.reduce((s, n) => s + n.planted.length, 0)} planted items`)
  console.log('  scenarios:', ['investigation', 'accommodation', 'termination'].map((s) => `${s} ${count((n) => n.scenario === s)}`).join(', '))
  console.log('  styles:', ['prose', 'bullets', 'terse'].map((s) => `${s} ${count((n) => n.style === s)}`).join(', '))
  console.log('  notes with each culture:', CULTURES.map((cu) => `${cu.id} ${features(`culture:${cu.id}`)}`).join(', '))
  console.log('  features:', ['nickname', 'typo', 'prose-typo', 'caps', 'indirect-id'].map((f) => `${f} ${features(f)}`).join(', '))
  console.log('  planted by type:', Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', '))
}

function main() {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const seed = Number(arg('seed', '1130'))
  const out = arg('out', 'data/cases')
  const warning = 'SYNTHETIC DATA. Every name, number and detail is made up. Do not add real case notes here.'

  const a = generateSet('A', seed, 60)
  const b = generateSet('B', seed + 7919, 60)
  checkSetsAreDisjoint(a, b)
  checkCoverage('A', a)
  checkCoverage('B', b)

  mkdirSync(out, { recursive: true })
  for (const [label, notes] of [['A', a], ['B', b]] as const) {
    const file = `${out}/set-${label.toLowerCase()}.json`
    writeFileSync(file, `${JSON.stringify({ meta: { set: label, seed: label === 'A' ? seed : seed + 7919, count: notes.length, warning }, notes }, null, 2)}\n`)
    console.log(`wrote ${file}`)
    stats(label, notes)
  }
}

main()
