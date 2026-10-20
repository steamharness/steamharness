import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import type { AccountState } from '../workflow-auth-client';
import type { Project } from '../workflow-types';
import { iconHtml } from './ui';

const rendered = new WeakMap<HTMLElement, { src?: string }>();
let projectKey = '', projectSource = '';

export function accountAvatarUrl(account?: AccountState): string | undefined {
  if (!account?.user?.avatarUrl) { return; }
  try {
    const url = new URL(account.user.avatarUrl, account.serverUrl ? `${account.serverUrl}/` : undefined);
    const imageData = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url.href) && url.href.length <= 1024 * 1024;
    if ((['http:', 'https:'].includes(url.protocol) || imageData) && !url.username && !url.password) { return url.href; }
  } catch { /* Missing or invalid account images use the account glyph. */ }
  return undefined;
}

function updateAvatar(root: HTMLElement, src?: string, fallbackIcon = 'account'): void {
  if (rendered.has(root) && rendered.get(root)!.src === src) { return; }
  const entry = { src }; rendered.set(root, entry);
  root.innerHTML = iconHtml(fallbackIcon);
  if (!src) { return; }
  const fallback = root.firstElementChild as HTMLElement;
  const image = document.createElement('img');
  image.alt = ''; image.hidden = true; image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => {
    if (rendered.get(root) !== entry) { return; }
    image.hidden = false; fallback.hidden = true;
  });
  image.addEventListener('error', () => {
    if (rendered.get(root) !== entry) { return; }
    image.hidden = true; fallback.hidden = false;
  });
  root.append(image); image.src = src;
}

export function updateUserAvatar(root: HTMLElement, account?: AccountState): void {
  updateAvatar(root, accountAvatarUrl(account));
}

export function updateProjectAvatar(root: HTMLElement, project: Pick<Project, 'projectType' | 'projectCard'>): void {
  const key = JSON.stringify([project.projectType, project.projectCard]);
  if (key !== projectKey) { projectKey = key; projectSource = projectAvatarDataUrl(project.projectCard, project.projectType); }
  updateAvatar(root, projectSource, 'package');
}
