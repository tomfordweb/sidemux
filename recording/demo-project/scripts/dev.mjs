#!/usr/bin/env node
// Synthetic vite dev server: prints a ready banner, then a slow trickle of
// request/HMR lines forever (until the pane is killed). Demo data only.
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(400);
console.log(`\n  ${bold(green("VITE"))} ${green("v6.0.3")}  ${dim("ready in")} ${bold("412 ms")}\n`);
console.log(`  ${green("➜")}  ${bold("Local")}:   ${cyan("http://localhost:5173/")}`);
console.log(`  ${green("➜")}  ${bold("Network")}: ${dim("use --host to expose")}\n`);

const events = [
  `${dim(new Date().toTimeString().slice(0, 8))} ${cyan("[vite]")} hmr update ${dim("/src/components/Header.tsx")}`,
  `${dim(new Date().toTimeString().slice(0, 8))} ${cyan("[vite]")} page reload ${dim("src/routes/index.tsx")}`,
  `${dim(new Date().toTimeString().slice(0, 8))} ${cyan("[vite]")} hmr update ${dim("/src/features/cart/CartDrawer.tsx")}`,
];
let i = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  await sleep(2500);
  console.log(events[i % events.length]);
  i += 1;
}
