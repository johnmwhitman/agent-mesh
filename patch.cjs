const fs = require('fs');

// Patch test/spawn-result.test.ts
const testFile = 'test/spawn-result.test.ts';
let testContent = fs.readFileSync(testFile, 'utf8');

testContent = testContent.replace(
  "  const noKeyword = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, 'level=ERROR error.error='].join('\\n') })\n  assert.equal(noKeyword.success, true)\n  assert.equal(noKeyword.warning, undefined)",
  "  const noKeyword = classifySpawnResult({ exitCode: 0, stdout: 'ok', stderr: [primary, 'level=ERROR error.error='].join('\\n') })\n  assert.equal(noKeyword.success, false)\n  assert.match(noKeyword.error ?? '', /Fatal primary provider error: level=ERROR error.error=/)"
);

// We need to update the comment as well
testContent = testContent.replace(
  "  // The bare `level=ERROR error.error=` record (no diagnostic keyword) is not\n  // a diagnostic line at all (pre-existing keyword-discovery scope); pinned so\n  // a change there is a deliberate decision, not a side effect.",
  "  // The bare `level=ERROR error.error=` record (no diagnostic keyword) is still\n  // surfaced as an error to prevent silent failures (regression test for issue #201)."
);
fs.writeFileSync(testFile, testContent);
