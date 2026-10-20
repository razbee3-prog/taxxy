function g(d: string): string {
  return d.replace(/-/g, "/");
}

/** Receipts and invoices with attachments inside the installment period. */
export function receiptQuery(from: string, to: string, extra?: string): string {
  const base = `has:attachment (receipt OR invoice OR order) after:${g(from)} before:${g(to)}`;
  return extra ? `${base} ${extra}` : base;
}

/** Prior-year 1040 search: attachments named like a 1040 or threads about the return. */
export function priorYearQuery(taxYear: number): string {
  return `(filename:1040 OR subject:"tax return") after:${taxYear + 1}/01/01 before:${taxYear + 2}/01/01`;
}
