import { configureLocalization } from '../src/localization';

const data = typeof document === 'undefined' ? undefined : document.getElementById('studio-localization')?.textContent;
if (data) {
  const { bundle, locale } = JSON.parse(data);
  configureLocalization(bundle, locale);
}

export { t, locale } from '../src/localization';
