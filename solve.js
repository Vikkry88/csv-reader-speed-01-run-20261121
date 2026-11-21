// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader's
// readCsv returns for {text, header} — {columns, rows, errors} — but finds field
// boundaries with native indexOf scans instead of walking the text one character
// at a time and building every field character by character.
//
// How it stays fast:
//  - Three delimiter pointers (next comma, next LF, next CR at or after the read
//    position) are cached and refreshed with a single indexOf each as the read
//    position passes them, so total native scanning is linear and most fields
//    cost one slice.
//  - A quoted field's closing quote is found with indexOf (skipping doubled
//    pairs); when its content holds no escaped quote and no CR, the value is one
//    slice and its line count is tallied with indexOf.
//  - Only fields that need rewriting — a stray CR outside quotes, an escaped
//    quote or a CR inside quotes — take a segmented char-code scan that joins a
//    few slices.
//
// The broken-row policy is csv-reader's exactly: BOM dropped, empty lines are no
// record, stray CRs dropped (stray_cr), junk after a closing quote appended
// (quote_junk), a quote that never closes read as a literal and its text re-read
// as unquoted (unterminated_quote), ragged rows padded/cut to the first record's
// width (short_row/long_row), errors in the order met with the record's start
// line and row index.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next index to read
  let line = 1; // 1-based line `pos` sits on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: errors carry its start line and its index in rows
  // (null while the header record is being read).
  let recordLine = 1;
  let recordRow = null;

  // Scratch results of the field readers (avoids a result object per field).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0; // characters kept by the last readUnquoted call (for quote_junk)

  // First occurrence at or after `pos` of each delimiter (-1: none). `pos` only
  // moves forward (except the unterminated-quote re-read, which recomputes all
  // three), so each pointer is refreshed with one indexOf from the new pos.
  let NC = text.indexOf(',', pos);
  let NL = text.indexOf('\n', pos);
  let NR = text.indexOf('\r', pos);

  // Char-code unquoted reader, used when a stray CR sits in the field: keeps the
  // characters around each stray CR as slices and drops the CRs (stray_cr).
  function readUnquotedSlow(prefix) {
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || c === 13) break;
      i += 1;
    }
    if (i >= n) { fValue = prefix + text.slice(pos, i); fAdded = i - pos; fEnded = END; pos = i; return; }
    const c = text.charCodeAt(i);
    if (c === 44) { fValue = prefix + text.slice(pos, i); fAdded = i - pos; fEnded = COMMA; pos = i + 1; return; }
    if (c === 10) { fValue = prefix + text.slice(pos, i); fAdded = i - pos; fEnded = LINE_BREAK; pos = i + 1; line += 1; return; }
    if (i + 1 < n && text.charCodeAt(i + 1) === 10) { fValue = prefix + text.slice(pos, i); fAdded = i - pos; fEnded = LINE_BREAK; pos = i + 2; line += 1; return; }
    const parts = [prefix, text.slice(pos, i)];
    let added = i - pos;
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    i += 1;
    let seg = i;
    for (;;) {
      while (i < n) {
        const cc = text.charCodeAt(i);
        if (cc === 44 || cc === 10 || cc === 13) break;
        i += 1;
      }
      if (i >= n) { parts.push(text.slice(seg, i)); added += i - seg; pos = i; fEnded = END; break; }
      const cc = text.charCodeAt(i);
      if (cc === 44) { parts.push(text.slice(seg, i)); added += i - seg; pos = i + 1; fEnded = COMMA; break; }
      if (cc === 10) { parts.push(text.slice(seg, i)); added += i - seg; pos = i + 1; line += 1; fEnded = LINE_BREAK; break; }
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) { parts.push(text.slice(seg, i)); added += i - seg; pos = i + 2; line += 1; fEnded = LINE_BREAK; break; }
      parts.push(text.slice(seg, i));
      added += i - seg;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      i += 1;
      seg = i;
    }
    fValue = parts.join('');
    fAdded = added;
  }

  // Reads unquoted characters from `pos` onto `prefix` up to the next comma,
  // line break or the end of the text, via the delimiter pointers.
  function readUnquoted(prefix) {
    if (NC !== -1 && NC < pos) NC = text.indexOf(',', pos);
    if (NL !== -1 && NL < pos) NL = text.indexOf('\n', pos);
    if (NR !== -1 && NR < pos) NR = text.indexOf('\r', pos);
    let end, kind;
    if (NC === -1 && NL === -1) { end = n; kind = END; }
    else if (NL === -1 || (NC !== -1 && NC < NL)) { end = NC; kind = COMMA; }
    else { end = NL; kind = LINE_BREAK; }
    const isCRLF = kind === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13;
    if (NR !== -1 && NR < end && !(isCRLF && NR === end - 1)) {
      readUnquotedSlow(prefix);
      return;
    }
    const vEnd = isCRLF ? end - 1 : end;
    fValue = prefix === '' ? text.slice(pos, vEnd) : prefix + text.slice(pos, vEnd);
    fAdded = vEnd - pos;
    fEnded = kind;
    if (kind === COMMA) pos = end + 1;
    else if (kind === LINE_BREAK) { pos = end + 1; line += 1; }
    else pos = end;
  }

  // Reads a field whose opening quote is at `pos`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote, skipping doubled pairs ("" is one literal quote).
    let q = text.indexOf('"', pos);
    let hasEscaped = false;
    while (q !== -1 && q + 1 < n && text.charCodeAt(q + 1) === 34) {
      hasEscaped = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      NC = text.indexOf(',', pos);
      NL = text.indexOf('\n', pos);
      NR = text.indexOf('\r', pos);
      readUnquoted('"');
      return;
    }
    if (NR !== -1 && NR < pos) NR = text.indexOf('\r', pos);
    const hasCR = NR !== -1 && NR < q;
    let value;
    if (!hasEscaped && !hasCR) {
      value = text.slice(pos, q);
      let lf = text.indexOf('\n', pos);
      while (lf !== -1 && lf < q) { line += 1; lf = text.indexOf('\n', lf + 1); }
      pos = q + 1;
    } else {
      // Segmented scan: escaped quotes to un-double, CRLF/lone CR read as LF.
      let segStart = pos;
      const parts = [];
      while (pos < n) {
        const c = text.charCodeAt(pos);
        if (c === 34) {
          if (pos + 1 < n && text.charCodeAt(pos + 1) === 34) {
            parts.push(text.slice(segStart, pos), '"');
            pos += 2;
            segStart = pos;
            continue;
          }
          parts.push(text.slice(segStart, pos));
          pos += 1;
          break;
        }
        if (c === 13) {
          parts.push(text.slice(segStart, pos), '\n');
          line += 1;
          pos += pos + 1 < n && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
          segStart = pos;
          continue;
        }
        if (c === 10) line += 1;
        pos += 1;
      }
      value = parts.join('');
    }
    if (pos >= n) { fValue = value; fEnded = END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fValue = value; fEnded = COMMA; return; }
    if (c === 10) { pos += 1; line += 1; fValue = value; fEnded = LINE_BREAK; return; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fValue = value; fEnded = LINE_BREAK; return; }
    // Whatever follows the closing quote, up to the next comma or line break, is
    // appended as it stands; quote_junk is recorded when the field ends, after
    // any stray_cr met inside the junk.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      if (lastQuoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
