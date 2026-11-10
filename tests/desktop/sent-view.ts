// 11-10: the middleware now sends `\u2063[label]\u2063` and orders the image attachments so the k-th
// label is the k-th image. These helpers turn that back into the older `![alt](attached:k)` view
// (k = the image's place before the reordering, appended images after the original ones), so the
// binding tests keep asserting which image goes where.
type Att = { id?: string; kind?: string; path?: string } | null | undefined
type Draft = { text: string; attachments?: Att[] }

const altOf = (label: string) => (label.startsWith('图：') ? label.slice(2) : label)

export function legacyText(out: Draft, input: Draft): string {
  const before = (input.attachments ?? []).filter(a => a?.kind === 'image')
  const after = (out.attachments ?? []).filter(a => a?.kind === 'image')
  const isBefore = (a: Att) => before.some(b => b === a || (b?.id !== undefined && b?.id === a?.id))
  const added = after.filter(a => !isBefore(a))
  const original = (a: Att) => {
    const i = before.findIndex(b => b === a || (b?.id !== undefined && b?.id === a?.id))
    return i >= 0 ? i : before.length + added.indexOf(a)
  }
  let k = 0
  return noCount(out.text)
    .replace(/\u2063\[([^\]\n]*)\]\u2063/g, (_m, label: string) => `![${altOf(label)}](attached:${original(after[k++]) + 1})`)
    .replace(/\[([^\]\n]*)：未对上的附件\]/g, (_m, label: string) => `![${altOf(label)}](未对上的附件)`)
}

/** The sent text without the trailing image-count token (review 11-10); countOf reads it. */
const COUNT_RE = /\u2063([\u{E0030}-\u{E0039}]+)\u2063$/u
export const noCount = (text: string) => text.replace(COUNT_RE, '')
export const countOf = (text: string): number | null => {
  const m = COUNT_RE.exec(text)
  return m ? Number(Array.from(m[1], c => String.fromCharCode(c.codePointAt(0)! - 0xe0000)).join('')) : null
}
