export function bindAvatar(image: HTMLImageElement, placeholder: HTMLElement): (url?: string) => void {
  const showImage = (loaded: boolean): void => {
    image.hidden = !loaded;
    placeholder.hidden = loaded;
  };
  const synchronize = (): void => { showImage(image.complete && image.naturalWidth > 0); };
  image.addEventListener('load', synchronize);
  image.addEventListener('error', synchronize);

  return url => {
    if (url && image.getAttribute('src') === url) { return; }
    showImage(false);
    if (url) { image.src = url; }
    else { image.removeAttribute('src'); }
  };
}
