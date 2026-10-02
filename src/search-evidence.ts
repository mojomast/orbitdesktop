/** Textareas normalize CRLF/CR to LF; citations always address original UTF-16. */
export function sourceSelectionOffsets(text: string, start: number, end: number): [number, number] {
  if (end <= start) return [0, text.length];
  const boundaries = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    boundaries.push(i + 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= boundaries.length) throw Error('Invalid source selection.');
  return [boundaries[start], boundaries[end]];
}

export interface KnowledgeExcerptEvidence {
  sourceId: string;
  extractor: string;
  textSha256: string;
  contentSha256: string;
  start: number;
  end: number;
}
export function formatKnowledgeExcerpt(text: string, evidence: KnowledgeExcerptEvidence): string {
  if (text.length !== evidence.end - evidence.start) throw Error('Excerpt offsets do not match included text.');
  const payload = `${text}\n\n[Knowledge included-excerpt]\nSource: ${evidence.sourceId}\nExtractor: ${evidence.extractor}\nText SHA256: ${evidence.textSha256}\nContent SHA256: ${evidence.contentSha256}\nUTF-16 offsets: [${evidence.start}, ${evidence.end})`;
  if (payload.length > 20000) throw Error('Excerpt and citation exceed 20,000 characters. Select a shorter excerpt.');
  return payload;
}
