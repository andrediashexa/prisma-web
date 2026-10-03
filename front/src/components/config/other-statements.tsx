/**
 * A block's statements no typed field takes (GetConfig's `other`, #46), shown
 * as the box wrote them and never edited here: they are reached as lines on
 * the Settings page.
 */
export function OtherStatements({ title, lines }: { title: string; lines?: string[] }) {
  if (!lines?.length) return null
  return (
    <section className="space-y-1" data-testid="other-statements" aria-label={title}>
      <h3 className="text-muted-foreground text-xs font-medium">{title} (read only; edited on the Settings page)</h3>
      <ul className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-xs leading-5">
        {lines.map((l, i) => (
          <li key={`${i}-${l}`} className="break-all">
            {l}
          </li>
        ))}
      </ul>
    </section>
  )
}
