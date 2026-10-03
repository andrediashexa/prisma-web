// Server-Sent Events read with fetch (#49, #50): unlike EventSource, a refusal's
// status and JSON reach the page, and a POST can carry a body.

/** Reads one Server-Sent Events body: each `event:`/`data:` block as it arrives. */
export async function readEvents(res: Response, on: (event: string, data: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += value
    let end
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end)
      buf = buf.slice(end + 2)
      let event = "message"
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      if (data.length) on(event, data.join("\n"))
    }
  }
}
