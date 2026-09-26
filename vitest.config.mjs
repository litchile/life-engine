// Candidate exports may live under .tmp; never discover their tests as source tests.
export default { test: { include: ["tests/**/*.{test,spec}.{js,ts,mjs,cjs,jsx,tsx}"] } };
