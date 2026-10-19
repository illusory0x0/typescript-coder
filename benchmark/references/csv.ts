export function parseCsv(text: string): string[][] {
  if (text.length === 0) {
    return [];
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;
  let endedWithTerminator = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        closedQuote = true;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (closedQuote) {
      if (char === ",") {
        endField();
        i += 1;
        continue;
      }
      if (char === "\n") {
        endRow();
        endedWithTerminator = true;
        i += 1;
        continue;
      }
      if (char === "\r" && text[i + 1] === "\n") {
        endRow();
        endedWithTerminator = true;
        i += 2;
        continue;
      }
      throw new Error(`unexpected character ${JSON.stringify(char)} after a closing quote`);
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      endedWithTerminator = true;
      i += 1;
      continue;
    }
    if (char === "\r" && text[i + 1] === "\n") {
      endRow();
      endedWithTerminator = true;
      i += 2;
      continue;
    }
    field += char;
    endedWithTerminator = false;
    i += 1;
  }

  if (!endedWithTerminator) {
    endRow();
  }
  return rows;
}
