import { t } from '../localization';
import { requestAction } from './action-dialog';
import { iconHtml } from './ui';

type Request = (operation: string, input: Record<string, unknown>) => Promise<any>;
const button = (title: string, action: () => void, className = '') => {
  const control = document.createElement('button'); control.type = 'button'; control.textContent = title;
  control.className = className; control.onclick = action; return control;
};

/** Lists and editors use the current entry's grant, just like project code. */
export function mountDatabaseData(container: HTMLElement, request: Request): () => void {
  let active = true, revision = 0;
  const tabs = document.createElement('div'); tabs.className = 'database-data-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('Data type'));
  const body = document.createElement('div'); body.className = 'database-data-body';
  const status = document.createElement('p'); status.className = 'database-data-status'; status.setAttribute('role', 'status'); status.hidden = true;
  let kind = 'kv';
  const showStatus = (message: string, error = false) => {
    status.hidden = !message; status.textContent = message; status.dataset.error = String(error); status.setAttribute('role', error ? 'alert' : 'status');
  };
  const render = () => {
    const current = ++revision;
    for (const tab of tabs.querySelectorAll<HTMLButtonElement>('button')) tab.setAttribute('aria-pressed', String(tab.dataset.kind === kind));
    body.replaceChildren(); showStatus('');
    const run = async (operation: string, input: Record<string, unknown>, receive: (value: any) => void) => {
      showStatus(t('Loading data...'));
      try {
        const value = await request(operation, input);
        if (active && current === revision) { showStatus(''); receive(value); }
      } catch (error) {
        if (active && current === revision) showStatus(error instanceof Error ? error.message : String(error), true);
      }
    };
    const field = (form: HTMLElement, title: string, multiline = false) => {
      const label = document.createElement('label'); label.textContent = title;
      const input = multiline ? document.createElement('textarea') : document.createElement('input');
      input.setAttribute('aria-label', title); label.append(input); form.append(label); return input;
    };
    const submit = (form: HTMLFormElement, title: string, action: () => void) => {
      const save = button(title, () => {}, 'database-primary'); save.type = 'submit'; form.append(save);
      form.onsubmit = event => { event.preventDefault(); action(); };
    };
    const remove = async (operation: string, input: Record<string, unknown>, name: string, done: () => void) => {
      const confirmed = await requestAction({ title: t('Delete database data?'), confirm: t('Delete'),
        description: t('Delete {0}? Every entry sharing this database will see this change.', name), danger: true });
      if (confirmed !== undefined && active && current === revision) void run(operation, input, done);
    };
    if (kind === 'files') {
      const intro = document.createElement('p'); intro.className = 'database-muted'; intro.textContent = t('Upload an attachment, or enter its ID to download or delete it.');
      const uploadLabel = document.createElement('label'); uploadLabel.className = 'database-upload'; uploadLabel.innerHTML = `${iconHtml('cloud-upload')}<span>${t('Upload attachment')}</span>`;
      const upload = document.createElement('input'); upload.type = 'file'; upload.setAttribute('aria-label', t('Upload attachment')); uploadLabel.append(upload);
      const form = document.createElement('form'); form.className = 'database-editor';
      const id = field(form, t('Attachment ID')); id.required = true;
      const metadata = document.createElement('dl'); metadata.className = 'database-record-metadata';
      const showFile = (file: { id: string; name: string; mimeType?: string }) => {
        id.value = file.id; metadata.replaceChildren();
        for (const [label, value] of [[t('Name'), file.name], [t('Type'), file.mimeType]]) {
          if (!value) continue;
          const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label!; detail.textContent = value; metadata.append(term, detail);
        }
      };
      upload.onchange = () => {
        const file = upload.files?.[0]; if (!file) return;
        if (file.size > 50 * 1024 * 1024) { showStatus(t('Attachments cannot exceed 50 MiB.'), true); return; }
        void file.arrayBuffer().then(bytes => {
          if (!active || current !== revision) return;
          let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
          return run('files.createFile', { name: file.name, mimeType: file.type, base64: btoa(binary) }, result => { showFile(result); showStatus(t('Attachment uploaded.')); });
        }).catch(error => { if (active && current === revision) showStatus(String(error), true); });
      };
      submit(form, t('Download attachment'), () => { void run('files.readFile', { fileId: id.value }, result => {
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mimeType }));
        const link = document.createElement('a'); link.href = url; link.download = result.file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); showFile(result.file);
      }); });
      form.append(button(t('Delete attachment'), () => { if (form.reportValidity()) void remove('files.deleteFile', { fileId: id.value }, id.value, () => { id.value = ''; metadata.replaceChildren(); showStatus(t('Attachment deleted.')); }); }, 'database-danger'));
      body.append(intro, uploadLabel, form, metadata); return;
    }
    const knowledge = kind === 'knowledge';
    const toolbar = document.createElement('div'); toolbar.className = 'database-data-toolbar';
    const search = document.createElement('form'); search.className = 'database-search';
    const query = document.createElement('input'); query.type = 'search'; query.placeholder = query.ariaLabel = knowledge ? t('Search knowledge') : t('Search keys');
    const searchButton = button(t('Search'), () => {}); searchButton.type = 'submit'; search.append(query, searchButton);
    toolbar.append(search, button(knowledge ? t('Create document') : t('Add value'), () => edit()));
    const layout = document.createElement('div'); layout.className = 'database-data-layout';
    const listing = document.createElement('div'); listing.className = 'database-records';
    const rows = document.createElement('div'); rows.className = 'database-record-list';
    const pagination = document.createElement('div'); pagination.className = 'database-pagination';
    const count = document.createElement('span');
    let cursors: (string | undefined)[] = [undefined], page = 0, nextCursor: string | undefined, searchQuery = '';
    const previous = button(t('Previous page'), () => { page--; load(); }); previous.disabled = true;
    const next = button(t('Next page'), () => { if (nextCursor) { cursors[++page] = nextCursor; load(); } }); next.disabled = true;
    pagination.append(count, previous, next); listing.append(rows, pagination);
    const editor = document.createElement('div'); editor.className = 'database-record-detail';
    const placeholder = document.createElement('p'); placeholder.className = 'database-empty-detail'; placeholder.textContent = knowledge ? t('Select a document to view or edit it.') : t('Select a key to view or edit its value.'); editor.append(placeholder);
    layout.append(listing, editor); body.append(toolbar, layout);
    const select = (id: string) => {
      for (const row of rows.querySelectorAll<HTMLButtonElement>('button')) row.setAttribute('aria-pressed', String(row.dataset.id === id));
      void run(knowledge ? 'knowledge.getDocument' : 'kv.getValue', knowledge ? { documentId: id } : { key: id }, result => {
        if (knowledge && !result) { showStatus(t('This document no longer exists.'), true); return; }
        edit(knowledge ? result : { key: id, value: result });
      });
    };
    function edit(record?: any) {
      editor.replaceChildren();
      const heading = document.createElement('h4'); heading.textContent = record ? t('Edit record') : knowledge ? t('Create document') : t('Add value'); editor.append(heading);
      const form = document.createElement('form'); form.className = 'database-editor';
      const id = field(form, knowledge ? t('Document ID') : t('Key')); id.value = record?.[knowledge ? 'id' : 'key'] ?? '';
      id.readOnly = !!record; id.required = !knowledge;
      if (knowledge && !record) { id.placeholder = t('Generated automatically when empty'); }
      const title = knowledge ? field(form, t('Title')) : undefined;
      if (title) { title.required = true; title.value = record?.title ?? ''; }
      const value = field(form, knowledge ? t('Markdown') : t('JSON value'), true); value.className = 'database-value-editor';
      value.value = knowledge ? record?.markdown ?? '' : record ? JSON.stringify(record.value, null, 2) : '';
      submit(form, t('Save'), () => {
        let input: Record<string, unknown>;
        if (knowledge) input = { ...(record ? { documentId: id.value } : id.value ? { id: id.value } : {}), title: title!.value, markdown: value.value };
        else {
          try { input = { key: id.value, value: JSON.parse(value.value) }; }
          catch { showStatus(t('Enter a valid JSON value.'), true); value.focus(); return; }
        }
        void run(knowledge ? record ? 'knowledge.editDocument' : 'knowledge.createDocument' : 'kv.setValue', input, result => {
          edit(knowledge ? result ?? { id: id.value, title: title!.value, markdown: value.value } : { key: id.value, value: input.value }); load();
        });
      });
      if (record) form.append(button(t('Delete'), () => { void remove(knowledge ? 'knowledge.deleteDocument' : 'kv.deleteValue', knowledge ? { documentId: id.value } : { key: id.value }, title?.value || id.value, () => { editor.replaceChildren(placeholder); load(); }); }, 'database-danger'));
      editor.append(form);
    }
    function load() {
      const searching = knowledge && searchQuery;
      void run(knowledge ? searching ? 'knowledge.searchDocuments' : 'knowledge.listDocuments' : 'kv.listValues', {
        pageSize: 20, ...(searchQuery ? { query: searchQuery } : {}), ...(cursors[page] ? { cursor: cursors[page] } : {}),
      }, result => {
        rows.replaceChildren(); nextCursor = result?.nextCursor;
        previous.disabled = page === 0; next.disabled = !nextCursor;
        count.textContent = t('{0} results · Page {1}', result?.total ?? result?.totalMatches ?? 0, page + 1);
        const items = searching ? result?.matches : result?.items;
        if (!items?.length) {
          const empty = document.createElement('p'); empty.className = 'database-empty-detail'; empty.textContent = searchQuery ? t('No matching records.') : t('This database has no records of this type.'); rows.append(empty);
        }
        for (const item of items ?? []) {
          const id = knowledge ? item.id ?? item.documentId : item.key;
          const row = button('', () => select(id), 'database-record'); row.dataset.id = id; row.setAttribute('aria-pressed', 'false');
          const name = document.createElement('strong'); name.textContent = knowledge ? item.title : item.key;
          const preview = document.createElement('span'); preview.textContent = knowledge ? item.markdownPreview ?? item.line : JSON.stringify(item.value);
          row.append(name, preview); rows.append(row);
        }
      });
    }
    search.onsubmit = event => { event.preventDefault(); searchQuery = query.value; cursors = [undefined]; page = 0; load(); };
    load();
  };
  for (const [value, title] of [['kv', t('Key-value data')], ['knowledge', t('Knowledge')], ['files', t('Attachments')]]) {
    const tab = button(title!, () => { kind = value!; render(); }); tab.dataset.kind = value; tabs.append(tab);
  }
  container.append(tabs, status, body); render();
  return () => { active = false; revision++; };
}
