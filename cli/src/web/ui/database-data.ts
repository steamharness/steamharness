import { t } from '../localization';
import { requestAction } from './action-dialog';

type Request = (operation: string, input: Record<string, unknown>, receive: (value: any) => void) => void;

/** These controls use the entry's approved grant, including knowledge and attachment checks. */
export function mountDatabaseData(container: HTMLElement, request: Request) {
  const field = (label: string, multiline = false) => {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const control = document.createElement(multiline ? 'textarea' : 'input'); wrapper.append(control); container.append(wrapper);
    return control;
  };
  const actions = document.createElement('div'); actions.className = 'database-actions';
  const output = document.createElement('pre'); output.className = 'database-data-result'; output.tabIndex = 0;
  const show = (value: unknown) => { output.textContent = JSON.stringify(value, null, 2) ?? t('No data'); };
  const button = (title: string, action: () => void) => {
    const result = document.createElement('button'); result.type = 'button'; result.textContent = title;
    result.onclick = action; actions.append(result);
  };
  const section = document.createElement('select'); section.setAttribute('aria-label', t('Data type'));
  for (const [value, title] of [['kv', 'KV'], ['knowledge', t('Knowledge')], ['files', t('Attachments')]]) {
    const option = document.createElement('option'); option.value = value!; option.textContent = title!; section.append(option);
  }
  container.append(section);
  const fields = document.createElement('div'); fields.className = 'database-data-fields'; container.append(fields);
  const redraw = () => {
    fields.replaceChildren(); actions.replaceChildren(); output.textContent = '';
    const add = (label: string, multiline = false) => { const control = field(label, multiline); fields.append(control.parentElement!); return control; };
    const remove = async (operation: string, input: Record<string, unknown>, description: string) => {
      if (await requestAction({ title: t('Delete database data?'), confirm: t('Delete'), description, danger: true }) !== undefined) request(operation, input, show);
    };
    if (section.value === 'kv') {
      const query = add(t('Search keys')), key = add(t('Key')), value = add(t('JSON value'), true);
      let cursor: string | undefined;
      button(t('List values'), () => { cursor = undefined; request('kv.listValues', { query: query.value, pageSize: 20 }, receive); });
      button(t('Next page'), () => { if (cursor) request('kv.listValues', { query: query.value, pageSize: 20, cursor }, receive); });
      function receive(result: any) { cursor = result?.nextCursor; show(result); }
      button(t('Read'), () => request('kv.getValue', { key: key.value }, result => { value.value = JSON.stringify(result, null, 2); show(result); }));
      button(t('Save'), () => { try { request('kv.setValue', { key: key.value, value: JSON.parse(value.value) }, show); } catch { show(t('Enter a valid JSON value.')); } });
      button(t('Delete'), () => { void remove('kv.deleteValue', { key: key.value }, key.value); });
    } else if (section.value === 'knowledge') {
      const query = add(t('Search knowledge')), id = add(t('Document ID')), title = add(t('Title')), markdown = add(t('Markdown'), true);
      let cursor: string | undefined;
      const receive = (result: any) => { cursor = result?.nextCursor; show(result); };
      button(t('List documents'), () => { cursor = undefined; request('knowledge.listDocuments', { query: query.value, pageSize: 20 }, receive); });
      button(t('Next page'), () => { if (cursor) request('knowledge.listDocuments', { query: query.value, pageSize: 20, cursor }, receive); });
      button(t('Read'), () => request('knowledge.getDocument', { documentId: id.value }, result => { if (result) { title.value = result.title; markdown.value = result.markdown; } show(result); }));
      button(t('Create document'), () => request('knowledge.createDocument', { ...(id.value ? { id: id.value } : {}), title: title.value, markdown: markdown.value }, result => { if (result) id.value = result.id; show(result); }));
      button(t('Save'), () => request('knowledge.editDocument', { documentId: id.value, title: title.value, markdown: markdown.value }, show));
      button(t('Delete'), () => { void remove('knowledge.deleteDocument', { documentId: id.value }, title.value || id.value); });
    } else {
      const id = add(t('Attachment ID'));
      const upload = document.createElement('input'); upload.type = 'file'; upload.setAttribute('aria-label', t('Upload attachment')); fields.append(upload);
      upload.onchange = () => {
        const file = upload.files?.[0]; if (!file) return;
        if (file.size > 50 * 1024 * 1024) { show(t('Attachments cannot exceed 50 MiB.')); return; }
        void file.arrayBuffer().then(bytes => {
          let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
          request('files.createFile', { name: file.name, mimeType: file.type, base64: btoa(binary) }, result => { if (result) id.value = result.id; show(result); });
        }).catch(error => show(String(error)));
      };
      button(t('Download attachment'), () => request('files.readFile', { fileId: id.value }, result => {
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mimeType }));
        const link = document.createElement('a'); link.href = url; link.download = result.file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); show(result.file);
      }));
      button(t('Delete'), () => { void remove('files.deleteFile', { fileId: id.value }, id.value); });
    }
  };
  container.append(actions, output); section.onchange = redraw; redraw();
}
