// The first `max` characters of a text, cut back to a paragraph break, line
// break or sentence end when one falls in the last third.
export function excerpt(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lo = Math.floor((max * 2) / 3);
  let cut = head.lastIndexOf("\n\n");
  if (cut < lo) cut = head.lastIndexOf("\n");
  if (cut < lo) {
    const ends = [...head.matchAll(/[.!?]["'”’)\]]*\s/g)];
    const m = ends[ends.length - 1];
    cut = m ? m.index + m[0].length : -1;
  }
  if (cut < lo) cut = head.lastIndexOf(" ");
  if (cut < lo) cut = max;
  return head.slice(0, cut).trimEnd();
}
