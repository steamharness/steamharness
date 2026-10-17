module.exports = {
  presets: [require.resolve("@docusaurus/core/lib/babel/preset")],
  overrides: [
    {
      test: /(docusaurus-theme-openapi-docs|docusaurus-plugin-openapi-docs)/,
      sourceType: "unambiguous",
    },
  ],
};
