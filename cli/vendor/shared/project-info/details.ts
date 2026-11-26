/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ProjectDetailsLabel = (en: string, zh: string) => string;

export interface ProjectDetailsEntry {
	entryId?: string;
	name: string;
	type: string;
	primary: boolean;
	avatarUrl?: string;
	available?: boolean;
}

export interface ProjectDetailsData {
	kind: 'folder' | 'workspace';
	uri: string;
	name: string;
	path?: string;
	projectId?: string;
	projectType?: string;
	avatarUrl?: string;
	description?: string;
	version?: string;
	distribution?: 'source' | 'release' | 'download';
	windowId?: number;
	dirty?: boolean;
	lastOpened?: number;
	missing?: boolean;
	entries?: readonly ProjectDetailsEntry[];
}

export type ProjectDetailFact = readonly [label: string, value: string | undefined];
export interface ProjectDetailSection {
	title: string;
	rows: readonly ProjectDetailFact[];
	expanded?: boolean;
}

interface EntryListOptions {
	heading?: 'h2' | 'h4';
	uri?: string;
	openEntry?(entryId: string): void;
}

interface ProjectDetailsOptions extends Pick<EntryListOptions, 'openEntry'> {
	title?: 'h1' | 'h3';
	fallbackIcon?: string;
	formatLabel?: string;
	locationLabel?: string;
	showWindowStatus?: boolean;
	currentWindow?: boolean;
	extraFacts?: readonly ProjectDetailFact[];
	sections?: readonly ProjectDetailSection[];
	actions?: readonly HTMLElement[];
	secondaryActions?: HTMLElement;
	usage?: HTMLElement;
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

function icon(doc: Document, name: string): HTMLElement {
	const node = element(doc, 'span', `codicon codicon-${name}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

export function projectDetailMark(doc: Document, avatarUrl: string | undefined, fallback: string): HTMLElement {
	if (!avatarUrl?.startsWith('data:image/')) { return icon(doc, fallback); }
	const img = element(doc, 'img');
	img.alt = ''; img.draggable = false; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.src = avatarUrl;
	return img;
}

export function typeLabel(type: string | undefined, t: ProjectDetailsLabel): string {
	switch (type) {
		case 'bot': return 'Bot';
		case 'kanban': return t('Kanban', '看板');
		case 'workflow': return t('Workflow', '工作流');
		case 'aggregate': return t('Multi-entry', '多入口');
		default: return t('Folder', '文件夹');
	}
}

export function edition(project: ProjectDetailsData, t: ProjectDetailsLabel): string {
	switch (project.distribution) {
		case 'download': return t('Downloaded source · Steam', '已下载源码 · Steam');
		case 'release': return t('Release · Steam', '发行版 · Steam');
		case 'source': return t('Source · IDE', '源码 · IDE');
		default: return project.kind === 'workspace' ? t('Workspace', '工作区') : project.projectType ? t('Project', '项目') : t('Folder', '文件夹');
	}
}

function addFact(list: HTMLDListElement, label: string, value?: string, className = ''): void {
	if (!value) { return; }
	const doc = list.ownerDocument, row = element(doc, 'div');
	row.append(element(doc, 'dt', '', label), element(doc, 'dd', className, value));
	list.append(row);
}

/** The shared details layout has no actions or host-only status unless supplied by its caller. */
export function renderProjectDetails(doc: Document, project: ProjectDetailsData, t: ProjectDetailsLabel, options: ProjectDetailsOptions = {}): HTMLElement {
	const page = element(doc, 'article', 'lp-project-details');
	const head = element(doc, 'header', 'lp-detail-head'), mark = element(doc, 'span', 'lp-detail-mark');
	mark.append(projectDetailMark(doc, project.avatarUrl, options.fallbackIcon ?? 'package'));
	const identity = element(doc, 'div', 'lp-detail-identity'), title = element(doc, options.title ?? 'h1', 'lp-detail-title', project.name);
	title.tabIndex = -1; title.dataset.key = 'detail:' + project.uri;
	identity.append(element(doc, 'span', 'lp-section-kicker', t('Project details', '项目详情')), title);
	const heading = element(doc, 'div', 'lp-detail-project');
	heading.append(mark, identity); head.append(heading);
	if (options.actions?.length) {
		const controls = element(doc, 'div', 'lp-detail-actions');
		controls.append(...options.actions); head.append(controls);
	}
	page.append(head);

	if (project.description?.trim()) { page.append(element(doc, 'p', 'lp-detail-description', project.description)); }
	const facts = element(doc, 'dl', 'lp-detail-facts');
	addFact(facts, t('Format', '项目形式'), options.formatLabel ?? edition(project, t));
	if (project.projectType) {
		addFact(facts, t('Project type', '项目类型'), typeLabel((project.entries?.length ?? 0) > 1 ? 'aggregate' : project.projectType, t), 'lp-detail-type');
	}
	addFact(facts, t('Version', '版本'), project.version);
	for (const [label, value] of options.extraFacts ?? []) { addFact(facts, label, value); }
	if (options.showWindowStatus) {
		addFact(facts, t('Window', '窗口状态'), project.missing ? t('Not found', '路径失效')
			: project.windowId === undefined && !options.currentWindow ? t('Closed', '未打开') : project.dirty ? t('Unsaved', '未保存') : t('Open', '已打开'));
		if (project.lastOpened !== undefined) { addFact(facts, t('Last opened', '最近打开时间'), new Date(project.lastOpened).toLocaleString(t('en', 'zh-CN'))); }
	}
	addFact(facts, options.locationLabel ?? t('Location', '位置'), project.path, 'lp-detail-location');
	addFact(facts, t('Project ID', '项目 ID'), project.projectId);
	page.append(facts);
	if (options.secondaryActions) { page.append(options.secondaryActions); }
	if (options.usage) { page.append(options.usage); }
	if (project.entries?.length) {
		page.append(renderProjectEntryList(doc, project.entries, t, { uri: project.uri, openEntry: options.openEntry, heading: options.title === 'h3' ? 'h4' : 'h2' }));
	}
	for (const section of options.sections ?? []) {
		if (!section.rows.length) { continue; }
		const disclosure = element(doc, 'details', 'lp-detail-disclosure'), list = element(doc, 'dl', 'lp-detail-facts');
		disclosure.open = !!section.expanded;
		for (const [label, value] of section.rows) { addFact(list, label, value); }
		disclosure.append(element(doc, 'summary', '', section.title), list); page.append(disclosure);
	}
	return page;
}

export function renderProjectEntryList(doc: Document, entries: readonly ProjectDetailsEntry[], t: ProjectDetailsLabel, options: EntryListOptions = {}): HTMLElement {
	const section = element(doc, 'section', 'lp-detail-entries'), list = element(doc, 'ul');
	for (const entry of entries) {
		const { entryId } = entry;
		const row = element(doc, 'li'), identity = element(doc, 'span', 'lp-entry-identity');
		if (entryId) { row.dataset.entryId = entryId; }
		identity.append(element(doc, 'strong', 'lp-entry-name', entry.name));
		if (entry.primary) { identity.append(element(doc, 'small', 'lp-entry-default', t('Default', '默认入口'))); }
		row.append(projectDetailMark(doc, entry.avatarUrl, 'extensions'), identity, element(doc, 'small', 'lp-entry-type', typeLabel(entry.type, t)));
		const openEntry = options.openEntry;
		if (entry.available === false) {
			row.append(element(doc, 'small', 'lp-entry-unavailable', t('Unavailable', '不可用')));
		} else if (entryId && openEntry) {
			const label = t('Open entry', '打开入口');
			const button = element(doc, 'button', 'lp-outline studio-project-action');
			button.type = 'button'; button.append(icon(doc, 'play'), label);
			button.setAttribute('aria-label', `${label}: ${entry.name}`);
			button.dataset.key = `entry:${options.uri}:${entryId}`;
			button.addEventListener('click', () => openEntry(entryId));
			row.append(button);
		}
		list.append(row);
	}
	section.append(element(doc, options.heading ?? 'h2', 'lp-entry-title', t('Project entries', '项目入口')), list);
	return section;
}
