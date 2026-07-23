#!/usr/bin/env node
// Synthetic vitest-style run: chatty, colored, ~5s. `--fail` makes one file
// fail with a realistic assertion diff. Demo data only.
const fail = process.argv.includes("--fail");
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`${bold(" RUN ")} ${dim("v3.2.1")} /work/acme-web\n`);
await sleep(400);

const files = [
  ["src/lib/format.test.ts", ["formats prices", "formats dates", "truncates labels"]],
  ["src/hooks/useFetch.test.ts", ["dedupes in-flight requests", "aborts on unmount", "retries 5xx once"]],
  ["src/store/session.test.ts", ["hydrates from storage", "expires stale tokens", "clears on logout"]],
  ["src/features/catalog/search.test.ts", ["ranks exact matches first", "ignores diacritics", "paginates results"]],
  ["src/features/cart/cart.test.ts", ["adds line items", "merges duplicate SKUs", "recomputes totals"]],
  ["src/features/checkout/checkout.test.ts", ["validates address", "applies discount codes", "computes tax by region"]],
];

let passed = 0;
for (const [file, tests] of files) {
  const isBroken = fail && file.endsWith("checkout.test.ts");
  await sleep(450);
  if (isBroken) {
    console.log(`${red("✗")} ${file} ${dim(`(${tests.length} tests | 1 failed)`)}`);
    for (const t of tests.slice(0, -1)) {
      console.log(`   ${green("✓")} ${dim(t)}`);
      passed += 1;
    }
    console.log(`   ${red("✗ computes tax by region")}`);
  } else {
    console.log(`${green("✓")} ${file} ${dim(`(${tests.length} tests)`)}`);
    passed += tests.length;
  }
}

await sleep(300);
if (fail) {
  console.log(`
${red(bold(" FAIL "))} src/features/checkout/checkout.test.ts ${dim(">")} computes tax by region
${red("AssertionError: expected 8.25 to be 8.75 // Object.is equality")}

${green("- Expected")}
${red("+ Received")}

${green("- 8.75")}
${red("+ 8.25")}

 ${dim("❯ src/features/checkout/tax.ts:42:11")}
 ${dim("❯ src/features/checkout/checkout.test.ts:87:29")}
`);
}
const failed = fail ? 1 : 0;
console.log(` ${dim("Test Files")}  ${fail ? red("1 failed | 5 passed") : green("6 passed")} ${dim("(6)")}`);
console.log(` ${dim("     Tests")}  ${fail ? `${red("1 failed")} ${dim("|")} ${green(`${passed} passed`)}` : green(`${passed} passed`)} ${dim(`(${passed + failed})`)}`);
console.log(` ${dim("  Duration")}  4.81s ${dim("(transform 612ms, setup 0ms, collect 1.94s)")}`);
process.exit(failed ? 1 : 0);
