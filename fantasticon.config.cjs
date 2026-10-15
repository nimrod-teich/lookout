// Builds media/lookout-icons.woff from icons/*.svg; `npm run icons`.
module.exports = {
  inputDir: "./icons",
  outputDir: "./media",
  name: "lookout-icons",
  fontTypes: ["woff"],
  assetTypes: [],
  normalize: true,
  fontHeight: 1000,
  codepoints: { lighthouse: 0xe900 },
};
