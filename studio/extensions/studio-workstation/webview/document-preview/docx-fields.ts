type PageFieldKind = 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES';
interface PageField { kind: PageFieldKind; format?: string }
interface SectionProperties { pageNumber?: { start?: number; format?: string } }
interface DocumentElement { children?: DocumentElement[]; className?: string; sectionProps?: SectionProperties }

export interface DocxDocument {
  documentPart: { body: DocumentElement & { children: DocumentElement[]; props: SectionProperties } };
  parts: { path: string; rootElement?: { type: string }; parseXml(root: Element): void }[];
  _package: { load(path: string): Promise<string | null>; parseXmlDocument(xml: string): Document };
}

interface PageFields {
  prefix: string;
  fields: Map<string, PageField>;
  sections: Map<string, SectionProperties>;
}

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function pageField(instruction: string): PageField | undefined {
  const kind = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instruction)?.[1].toUpperCase() as PageFieldKind | undefined;
  if (!kind) { return; }
  return { kind, format: /\\\*\s+(ROMAN|roman|Arabic|ALPHABETIC|alphabetic)\b/.exec(instruction)?.[1] };
}

function normalizeFields(xml: Document, state: PageFields): void {
  const marker = (field: PageField): string => {
    const token = `${state.prefix}_${state.fields.size}__`; state.fields.set(token, field); return token;
  };
  const textElement = (text: string): Element => {
    const node = xml.createElementNS(wordNamespace, 'w:t'); node.textContent = text; return node;
  };
  // docx-preview ignores simple fields and field runs. Normalize the in-memory XML only.
  for (const field of Array.from(xml.getElementsByTagNameNS(wordNamespace, 'fldSimple'))) {
    const parsed = pageField(field.getAttributeNS(wordNamespace, 'instr') ?? '');
    if (!parsed) { field.replaceWith(...Array.from(field.childNodes)); continue; }
    const original = field.getElementsByTagNameNS(wordNamespace, 'r')[0];
    const run = original?.cloneNode(false) as Element | undefined ?? xml.createElementNS(wordNamespace, 'w:r');
    const properties = original?.getElementsByTagNameNS(wordNamespace, 'rPr')[0];
    if (properties) { run.append(properties.cloneNode(true)); }
    run.append(textElement(marker(parsed))); field.replaceWith(run);
  }
  for (const paragraph of Array.from(xml.getElementsByTagNameNS(wordNamespace, 'p'))) {
    const stack: { instruction: string; controls: Element[]; result: Element[]; separated: boolean }[] = [];
    for (const node of Array.from(paragraph.getElementsByTagNameNS(wordNamespace, '*'))) {
      if (node.localName === 'fldChar' && node.getAttributeNS(wordNamespace, 'fldCharType') === 'begin') {
        stack.push({ instruction: '', controls: [node], result: [], separated: false }); continue;
      }
      const field = stack.at(-1); if (!field) { continue; }
      if (node.localName === 'instrText') { field.instruction += node.textContent ?? ''; field.controls.push(node); }
      else if (node.localName === 't' && field.separated) { field.result.push(node); }
      else if (node.localName === 'fldChar') {
        field.controls.push(node);
        const type = node.getAttributeNS(wordNamespace, 'fldCharType');
        if (type === 'separate') { field.separated = true; }
        else if (type === 'end') {
          stack.pop();
          if (stack.length) { continue; }
          const parsed = pageField(field.instruction); if (!parsed) { continue; }
          const token = marker(parsed);
          if (field.result.length) {
            field.result[0].textContent = token;
            for (const result of field.result.slice(1)) { result.remove(); }
          } else { field.controls[0].replaceWith(textElement(token)); }
          for (const control of field.controls) { control.remove(); }
        }
      }
    }
  }
}

export async function prepareDocxPageFields(document: DocxDocument): Promise<PageFields> {
  const state: PageFields = { prefix: `studio_field_${crypto.randomUUID().replace(/-/g, '')}`, fields: new Map(), sections: new Map() };
  for (const part of document.parts) {
    if (!['header', 'footer'].includes(part.rootElement?.type ?? '')) { continue; }
    const source = await document._package.load(part.path); if (!source) { continue; }
    const xml = document._package.parseXmlDocument(source);
    normalizeFields(xml, state); part.parseXml(xml.documentElement);
  }
  let props = document.documentPart.body.props, section = 0;
  for (const element of [...document.documentPart.body.children].reverse()) {
    if (element.sectionProps) { props = element.sectionProps; ++section; }
    const name = `${state.prefix}_section_${section}`;
    element.className = `${element.className ?? ''} ${name}`.trim(); state.sections.set(name, props);
  }
  return state;
}

function formatNumber(number: number, format: string): string {
  if (['ROMAN', 'roman', 'upperRoman', 'lowerRoman'].includes(format) && number > 0 && number < 4000) {
    let result = '', remaining = number;
    for (const [value, symbol] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
      [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const) {
      while (remaining >= value) { result += symbol; remaining -= value; }
    }
    return ['roman', 'lowerRoman'].includes(format) ? result.toLowerCase() : result;
  }
  if (['ALPHABETIC', 'alphabetic', 'upperLetter', 'lowerLetter'].includes(format) && number > 0) {
    let result = ''; for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) { result = String.fromCharCode(65 + (value - 1) % 26) + result; }
    return ['alphabetic', 'lowerLetter'].includes(format) ? result.toLowerCase() : result;
  }
  return String(number);
}

export function resolveDocxPageFields(body: HTMLElement, state: PageFields): void {
  const pages = Array.from(body.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx'));
  const sections = pages.map(page => {
    const element = page.querySelector('article > [class]');
    return Array.from(element?.classList ?? []).find(name => state.sections.has(name));
  });
  let number = 0, format = 'decimal', previous: string | undefined;
  for (const [index, page] of pages.entries()) {
    const section = sections[index], props = section ? state.sections.get(section) : undefined;
    const start = section !== previous ? props?.pageNumber?.start : undefined;
    number = start !== undefined && Number.isInteger(start) && start >= 0 ? start : number + 1;
    format = props?.pageNumber?.format ?? format; previous = section;
    const walker = body.ownerDocument.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.includes(state.prefix)) { continue; }
      for (const [token, field] of state.fields) {
        const value = field.kind === 'PAGE' ? number : field.kind === 'NUMPAGES' ? pages.length : sections.filter(name => name === section).length;
        node.textContent = node.textContent!.replaceAll(token, formatNumber(value, field.format ?? (field.kind === 'PAGE' ? format : 'decimal')));
      }
    }
  }
}
