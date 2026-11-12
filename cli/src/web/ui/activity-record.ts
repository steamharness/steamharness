import { t } from '../localization';
import type { Attachment, OutputItem } from '../workflow-types';
import { iconHtml, iconButton } from './ui';

export interface ActivityRecordContent {
  version: 1; kind: 'snapshot' | 'click' | 'input'; timestamp: string; title: string; summary?: string;
  fields?: { label: string; value: string }[]; text?: string; preview?: string; imageFileId?: string;
}
export function activityRecord(item?: OutputItem): ActivityRecordContent | undefined {
  const data = item?.content as ActivityRecordContent | undefined;
  return item?.metadata?.kind === 'activity-record' && data?.version === 1 && ['snapshot', 'click', 'input'].includes(data.kind) && typeof data.title === 'string' && typeof data.timestamp === 'string'
    && (data.text === undefined || typeof data.text === 'string')
    && (data.preview === undefined || typeof data.preview === 'string')
    && (data.fields === undefined || Array.isArray(data.fields) && data.fields.every(field => field && typeof field.label === 'string' && typeof field.value === 'string')) ? data : undefined;
}
export function activityRecordFiles(item: OutputItem, files: Attachment[]): Attachment[] { const record = activityRecord(item); return record?.imageFileId ? files.filter(file => file.id === record.imageFileId) : []; }
export function renderActivityRecord(record: ActivityRecordContent, files: Attachment[], options: { image(src: string, title: string): void; copy(text: string, button: HTMLButtonElement): void }): HTMLElement {
  const root = document.createElement('section'); root.className = 'activity-record'; root.dataset.kind = record.kind; root.dataset.slot = 'activity-record';
  const header = document.createElement('header'); header.className = 'activity-record-heading';
  const icon = document.createElement('span'); icon.innerHTML = iconHtml(record.kind === 'snapshot' ? 'file-media' : record.kind === 'input' ? 'edit' : 'symbol-event');
  const title = document.createElement('strong'); title.textContent = record.title;
  const time = document.createElement('time'); time.dateTime = record.timestamp;
  const date = new Date(record.timestamp);
  time.textContent = Number.isNaN(date.valueOf()) ? record.timestamp : new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
  header.append(icon, title, time); root.append(header);
  const body = document.createElement('div'); body.className = 'activity-record-body';
  const description = document.createElement('div'); description.className = 'activity-record-description'; body.append(description); root.append(body);
  if (record.fields?.length) {
    const fields = document.createElement('dl'); fields.className = 'activity-record-fields';
    for (const field of record.fields) {
      const name = document.createElement('dt'); name.textContent = String(field.label);
      const value = document.createElement('dd'); value.textContent = String(field.value); value.title = String(field.value); fields.append(name, value);
    }
    description.append(fields);
  }
  if (record.summary) { const summary = document.createElement('p'); summary.className = 'activity-record-summary'; summary.textContent = record.summary; description.append(summary); }
  const imageFile = record.imageFileId && files.find(file => file.id === record.imageFileId);
  if (imageFile) {
    const address = imageFile.previewUrl ?? imageFile.url;
    if (address) {
      const url = new URL(address, location.href);
      if (['http:', 'https:'].includes(url.protocol)) {
        const image = document.createElement('img'); image.className = 'activity-record-image'; image.dataset.recordFile = imageFile.id; image.src = url.href; image.alt = record.title; image.loading = 'lazy'; image.tabIndex = 0; image.setAttribute('role', 'button');
        const open = () => options.image(image.src, record.title);
        image.addEventListener('click', open); image.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        const media = document.createElement('figure'); media.className = 'activity-record-media'; media.append(image);
        body.classList.add('has-image'); body.append(media);
      }
    }
  }
  if (record.text) {
    const details = document.createElement('details'); details.className = 'activity-record-text';
    const summary = document.createElement('summary'); summary.textContent = record.kind === 'input' ? t('Input content · {0} characters', record.text.length) : t('Recognized text · {0} lines', record.text.split(/\r?\n/).length);
    const preview = document.createElement('pre'); preview.className = 'activity-record-preview'; preview.textContent = record.preview ?? record.text.split(/\r?\n/).slice(0, 5).join('\n');
    const content = document.createElement('pre'); content.textContent = record.text;
    const copy = iconButton('copy', t('Copy full text'), () => options.copy(record.text!, copy));
    details.append(summary, copy, content); if (record.kind !== 'input' && preview.textContent) description.append(preview); description.append(details);
    if (record.kind === 'input') details.open = true;
  }
  return root;
}
