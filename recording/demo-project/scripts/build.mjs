#!/usr/bin/env node
// Synthetic vite-style production build: chatty, colored, ~6s. Demo data only.
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modules = [];
const dirs = ["components", "routes", "hooks", "lib", "store", "features/cart", "features/checkout", "features/catalog"];
const names = ["index", "Button", "Modal", "useFetch", "api", "session", "ProductCard", "CartDrawer", "CheckoutForm", "PriceTag", "SearchBar", "Pagination", "Toast", "Skeleton", "Layout", "Header", "Footer", "Router", "guards", "format"];
for (const d of dirs) for (const n of names) modules.push(`src/${d}/${n}.ts`);

console.log(`${bold(cyan("vite"))} v6.0.3 ${green("building for production...")}`);
await sleep(300);
for (let i = 0; i < modules.length; i += 1) {
  process.stdout.write(`transforming (${i + 1}) ${dim(modules[i])}\n`);
  await sleep(25);
}
console.log(green(`✓ ${modules.length} modules transformed.`));
await sleep(400);
console.log("rendering chunks...");
await sleep(500);
console.log("computing gzip size...");
await sleep(300);
const rows = [
  ["dist/index.html", "  0.46 kB", " 0.30 kB"],
  ["dist/assets/index-B3xQk2ma.css", " 42.13 kB", " 8.22 kB"],
  ["dist/assets/vendor-Cwq9pLZ4.js", "141.87 kB", "45.63 kB"],
  ["dist/assets/index-D8fKq1vN.js", "312.44 kB", "98.05 kB"],
];
for (const [f, size, gz] of rows) {
  console.log(`${dim(f.padEnd(34))}${size} ${dim("│ gzip:")} ${gz}`);
}
console.log(green(`✓ built in 5.43s`));
