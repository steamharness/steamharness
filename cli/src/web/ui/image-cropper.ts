import type Cropper from 'cropperjs';
import type { ImageParamOptions } from 'steamharness';
import type { Field } from '../workflow-types';
import { t } from '../localization';
import { iconButton } from './ui';
import { cropOutputSize, imageOutputType, imageSizeAllowed, isImageFile, type ImageSize } from './image-crop-size';
import './image-cropper.css';

export function fileSelectionOptions(field: Field | undefined): Pick<Field, 'accept' | 'multiple' | 'image'> {
  return { accept: field?.accept, multiple: field?.multiple, image: field?.image };
}

function dimensionLabel(limits: ImageParamOptions): string {
  return t('Width {0}–{1} px; height {2}–{3} px.', limits.minWidth ?? 1, limits.maxWidth ?? t('No maximum'), limits.minHeight ?? 1, limits.maxHeight ?? t('No maximum'));
}

async function originalImageSize(file: File): Promise<ImageSize> {
  const image = new Image(), url = URL.createObjectURL(file);
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch { throw new Error(t('Could not read this image. Choose another image.')); }
  finally { image.src = ''; URL.revokeObjectURL(url); }
}

/** Process the entire selection before upload, so cancelling any editor uploads nothing. */
export async function prepareImageFiles(files: File[], limits?: ImageParamOptions, accept?: string[]): Promise<File[] | undefined> {
  if (!limits || !limits.crop && !['minWidth', 'minHeight', 'maxWidth', 'maxHeight'].some(key => limits[key as keyof ImageParamOptions] !== undefined)) return files;
  const prepared: File[] = [];
  for (const file of files) {
    if (!isImageFile(file)) { prepared.push(file); continue; }
    if (limits.crop) {
      const result = await cropImageFile(file, limits, accept);
      if (!result) return undefined;
      prepared.push(result);
    } else {
      if (!imageSizeAllowed(await originalImageSize(file), limits)) throw new Error(t('Image dimensions are outside the allowed range. {0}', dimensionLabel(limits)));
      prepared.push(file);
    }
  }
  return prepared;
}

export function cropImageFile(file: File, limits: ImageParamOptions, accept?: string[]): Promise<File | undefined> {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const url = URL.createObjectURL(file);
    const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog image-crop-dialog';
    const title = document.createElement('h2'); title.id = `crop-${crypto.randomUUID()}`; title.textContent = t('Crop image');
    dialog.setAttribute('aria-labelledby', title.id);
    const header = document.createElement('header'); header.append(title, iconButton('close', t('Close'), () => dialog.close()));
    const form = document.createElement('form'); form.className = 'dialog-body image-crop-body';
    const description = document.createElement('p'); description.className = 'image-crop-description'; description.textContent = `${file.name} · ${dimensionLabel(limits)}`;
    description.id = `${title.id}-description`; dialog.setAttribute('aria-describedby', description.id);
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'image-crop-toggle';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = true;
    toggleLabel.append(toggle, document.createTextNode(t('Enable cropping')));
    const viewport = document.createElement('div'); viewport.className = 'image-crop-viewport';
    const controls = document.createElement('div'); controls.className = 'image-crop-coordinates';
    const coordinates = new Map<string, HTMLInputElement>();
    for (const [name, label] of [['x', t('Crop left (px)')], ['y', t('Crop top (px)')], ['width', t('Crop width (px)')], ['height', t('Crop height (px)')]]) {
      const row = document.createElement('label'); row.textContent = label;
      const input = document.createElement('input'); input.className = 'field-control'; input.type = 'number'; input.step = '1'; input.min = name === 'x' || name === 'y' ? '0' : '1'; input.disabled = true;
      input.dataset.coordinate = name; coordinates.set(name, input); row.append(input); controls.append(row);
    }
    const status = document.createElement('p'); status.className = 'image-crop-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = t('Reading image…');
    const error = document.createElement('p'); error.className = 'error image-crop-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'prompt-navigation';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'prompt-button'; reset.textContent = t('Reset crop'); reset.disabled = true;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'prompt-button'; cancel.textContent = t('Cancel'); cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'prompt-button primary'; confirm.textContent = t('Use image'); confirm.disabled = true;
    actions.append(reset, cancel, confirm); form.append(description, toggleLabel, viewport, controls, status, error, actions); dialog.append(header, form);
    let result: File | undefined, closed = false, busy = false, ready = false, valid = true;
    let cropper: Cropper | undefined;
    let natural = { width: 0, height: 0 }, box = { x: 0, y: 0, width: 0, height: 0 };
    let crop = { x: 0, y: 0, width: 0, height: 0 };
    let observer: ResizeObserver | undefined;
    const showError = (message = '') => { error.textContent = message; error.hidden = !message; };
    const update = () => {
      confirm.disabled = !ready || busy || !valid || !toggle.checked && !imageSizeAllowed(natural, limits);
      reset.disabled = !ready || busy || !toggle.checked; toggle.disabled = busy;
      for (const [name, input] of coordinates) {
        input.disabled = !ready || busy || !toggle.checked;
        input.value = String(Math.round(crop[name as keyof typeof crop]));
      }
      const selection = cropper?.getCropperSelection(); if (selection) selection.hidden = !toggle.checked;
      if (!ready) return;
      if (!toggle.checked) {
        status.textContent = t('Original image: {0} × {1} px.', natural.width, natural.height);
        if (!imageSizeAllowed(natural, limits)) showError(t('The original image is outside the allowed range. Enable cropping to fit it.'));
      } else if (crop.width > 0 && crop.height > 0) {
        const output = cropOutputSize(crop, limits);
        status.textContent = t('Output: {0} × {1} px.', output.width, output.height) + ' ' + t('The crop is resized proportionally and padded when needed.');
      }
    };
    const layout = () => {
      const image = cropper?.getCropperImage(), canvas = cropper?.getCropperCanvas(), selection = cropper?.getCropperSelection();
      if (!ready || !image || !canvas || !selection || closed || !canvas.clientWidth || !canvas.clientHeight) return;
      image.scalable = true; image.translatable = true; image.$center('contain'); image.scalable = false; image.translatable = false;
      const parent = canvas.getBoundingClientRect(), bounds = image.getBoundingClientRect();
      box = { x: bounds.left - parent.left, y: bounds.top - parent.top, width: bounds.width, height: bounds.height };
      selection.$change(box.x + crop.x / natural.width * box.width, box.y + crop.y / natural.height * box.height,
        crop.width / natural.width * box.width, crop.height / natural.height * box.height);
      update();
    };
    for (const input of coordinates.values()) input.addEventListener('change', () => {
      const next = Object.fromEntries([...coordinates].map(([key, field]) => [key, field.value.trim() ? Number(field.value) : NaN])) as typeof crop;
      valid = Object.values(next).every(Number.isFinite) && next.x >= 0 && next.y >= 0 && next.width > 0 && next.height > 0 && next.x + next.width <= natural.width && next.y + next.height <= natural.height;
      if (!valid) { showError(t('The crop area must stay inside the image.')); confirm.disabled = true; return; }
      crop = next; showError(); layout();
    });
    reset.onclick = () => { crop = { x: 0, y: 0, ...natural }; valid = true; showError(); layout(); };
    toggle.onchange = () => { valid = true; showError(); update(); };
    form.onsubmit = event => {
      event.preventDefault();
      if (confirm.disabled || closed) return;
      if (!toggle.checked) { result = file; dialog.close(); return; }
      busy = true; showError(); update();
      void (async () => {
        try {
          const mime = imageOutputType(file, accept);
          if (!mime) throw new Error(t('Cropping requires PNG, JPEG or WebP in the accepted file types.'));
          const output = cropOutputSize(crop, limits);
          const cropped = await cropper!.getCropperSelection()!.$toCanvas({ width: output.contentWidth, height: output.contentHeight });
          if (closed) return;
          const canvas = document.createElement('canvas'); canvas.width = output.width; canvas.height = output.height;
          const context = canvas.getContext('2d'); if (!context) throw new Error();
          const left = Math.round((canvas.width - output.contentWidth) / 2), top = Math.round((canvas.height - output.contentHeight) / 2);
          context.fillStyle = '#ffffff';
          if (mime === 'image/jpeg') context.fillRect(0, 0, canvas.width, canvas.height);
          else {
            context.fillRect(0, 0, canvas.width, top);
            context.fillRect(0, top + output.contentHeight, canvas.width, canvas.height - top - output.contentHeight);
            context.fillRect(0, top, left, output.contentHeight);
            context.fillRect(left + output.contentWidth, top, canvas.width - left - output.contentWidth, output.contentHeight);
          }
          context.drawImage(cropped, left, top, output.contentWidth, output.contentHeight);
          const blob = await new Promise<Blob>((resolveBlob, reject) => canvas.toBlob(value => value ? resolveBlob(value) : reject(new Error()), mime, 0.92));
          if (closed) return;
          if (blob.type !== mime) throw new Error(t('This browser cannot export the accepted image format.'));
          const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
          result = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-cropped.${extension}`, { type: mime, lastModified: Date.now() });
          dialog.close();
        } catch (failure) { if (!closed) showError(failure instanceof Error && failure.message ? failure.message : t('Could not process the image. Adjust the crop and try again.')); }
        finally { busy = false; if (!closed) update(); }
      })();
    };
    const close = () => dialog.close();
    window.addEventListener('pagehide', close, { once: true });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
      else if (event.target instanceof HTMLInputElement && event.key.startsWith('Arrow')) event.stopPropagation();
    }, { capture: true });
    dialog.addEventListener('close', () => {
      closed = true; observer?.disconnect(); window.removeEventListener('pagehide', close); dialog.remove(); URL.revokeObjectURL(url);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    }, { once: true });
    document.body.append(dialog); dialog.showModal();
    void (async () => {
      try {
        const { default: ImageCropper } = await import('cropperjs');
        if (closed) return;
        const source = new Image(); source.src = url; source.alt = t('Image to crop'); viewport.append(source);
        cropper = new ImageCropper(source, { container: viewport });
        const image = cropper.getCropperImage(), selection = cropper.getCropperSelection();
        if (!image || !selection) throw new Error();
        const decoded = await image.$ready();
        if (closed) return;
        natural = { width: decoded.naturalWidth, height: decoded.naturalHeight };
        if (!natural.width || !natural.height) throw new Error();
        crop = { x: 0, y: 0, ...natural }; ready = true;
        image.rotatable = false; image.skewable = false;
        selection.keyboard = true; selection.movable = true; selection.resizable = true; selection.zoomable = false; selection.precise = true;
        selection.tabIndex = 0; selection.setAttribute('aria-label', t('Crop area. Use arrow keys to move the selection.'));
        selection.addEventListener('change', event => {
          const next = (event as CustomEvent<typeof box>).detail;
          if (!ready || !box.width || !box.height) return;
          if (next.x < box.x - 0.01 || next.y < box.y - 0.01 || next.x + next.width > box.x + box.width + 0.01 || next.y + next.height > box.y + box.height + 0.01 || next.width <= 0 || next.height <= 0) { event.preventDefault(); return; }
          crop = { x: Math.max(0, (next.x - box.x) / box.width * natural.width), y: Math.max(0, (next.y - box.y) / box.height * natural.height), width: next.width / box.width * natural.width, height: next.height / box.height * natural.height };
          valid = true; showError(); update();
        });
        await new Promise<void>(resolveFrame => requestAnimationFrame(() => { layout(); resolveFrame(); }));
        if (closed) return;
        observer = new ResizeObserver(layout); observer.observe(viewport);
      } catch { if (!closed) { ready = false; status.textContent = ''; showError(t('Could not read this image. Choose another image.')); update(); } }
    })();
  });
}
