import { integer } from '../models/client-definition-xml.js';

// DataOutput.GetPrintPage accepts descending ranges (no pages), zero and signed singles.
export function validPrintPages(value: string): boolean {
  if (!value) return true;
  return value.split(',').every((part) => {
    if (!part.includes('-')) return integer(part) !== undefined;
    if (!/^\d+-\d+$/.test(part)) return false;
    return part.split('-').every((number) => integer(number) !== undefined);
  });
}
