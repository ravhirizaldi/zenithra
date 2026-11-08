export function clientElement(name: string, value: unknown = ''): string {
  return `<${name}>${String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)}</${name}>`;
}

export function clientError(code: number, remark?: string | readonly string[]): string {
  const remarks = remark === undefined ? [] : typeof remark === 'string' ? [remark] : remark;
  return `<conmas><error>${clientElement('code', code)}<remarks>${remarks.map((value) => clientElement('remark', value)).join('')}</remarks></error></conmas>`;
}
