const language = process.env.STUDIO_TEST_UI_LANGUAGE;

// Source-mode VS Code skips language packs. Set the test host locale at its
// NLS environment boundary so the real extension API and scanners agree.
if (language && process.env.VSCODE_DEV) {
  process.env = new Proxy(process.env, {
    set(environment, key, value) {
      environment[key] = key === 'VSCODE_NLS_CONFIG' && value
        ? JSON.stringify({ ...JSON.parse(value), resolvedLanguage: language }) : value;
      return true;
    },
  });
}
