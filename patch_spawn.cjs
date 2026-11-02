const fs = require('fs');

// Patch src/spawn-result.ts
const srcFile = 'src/spawn-result.ts';
let srcContent = fs.readFileSync(srcFile, 'utf8');

srcContent = srcContent.replace(
  "    .filter((line) => /^\\s*Error:/i.test(line) || NO_CREDENTIALS.test(line) || PROVIDER_DIAGNOSTIC.test(line));",
  "    .filter((line) => /^\\s*Error:/i.test(line) || NO_CREDENTIALS.test(line) || PROVIDER_DIAGNOSTIC.test(line) || /\\blevel=ERROR\\b/.test(line));"
);

fs.writeFileSync(srcFile, srcContent);
