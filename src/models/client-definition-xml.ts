import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

export type XmlNode = Record<string, unknown>;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, suppressEmptyNode: true });
export const tag = (node: XmlNode) => Object.keys(node).find((key) => key !== ':@')!;
export const content = (node: XmlNode) => node[tag(node)] as XmlNode[];
export const children = (node: XmlNode, name: string) => content(node).filter((item) => Object.hasOwn(item, name));
export const child = (node: XmlNode, name: string) => children(node, name)[0];
export function must(node: XmlNode, name: string): XmlNode {
  const item = child(node, name);
  if (!item) throw new Error(`Missing definition element: ${name}`);
  return item;
}
export function value(node: XmlNode): string {
  return content(node)
    .map((item) => (Object.hasOwn(item, '#text') ? String(item['#text']) : value(item)))
    .join('');
}
export const field = (node: XmlNode, name: string) => value(must(node, name));
export const optionalField = (node: XmlNode, name: string): string => (child(node, name) ? field(node, name) : '');
export function integer(text: string): number | undefined {
  return /^[+-]?\d+$/.test(text.trim()) && Number(text) >= -2147483648 && Number(text) <= 2147483647
    ? Number(text)
    : undefined;
}
export function integerField(node: XmlNode, name: string): number {
  const number = integer(field(node, name));
  if (number === undefined) throw new Error(`Invalid definition integer: ${name}`);
  return number;
}
export const element = (name: string, text: string | XmlNode[] = ''): XmlNode => ({
  [name]: typeof text === 'string' ? (text ? [{ '#text': text }] : []) : text,
});
export function set(node: XmlNode, text: string): void {
  node[tag(node)] = content(element(tag(node), text));
}
export function remove(node: XmlNode, name: string): void {
  node[tag(node)] = content(node).filter((item) => !Object.hasOwn(item, name));
}
export function replace(node: XmlNode, name: string, text: string): void {
  remove(node, name);
  content(node).push(element(name, text));
}
export function root(xml: string): XmlNode {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid definition XML.');
  const node = (parser.parse(xml) as XmlNode[]).find(
    (item) => !tag(item).startsWith('?') && !tag(item).startsWith('#'),
  );
  if (!node) throw new Error('Missing definition XML root.');
  return node;
}
export const serialize = (node: XmlNode) => builder.build([node]) as string;
