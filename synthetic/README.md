# Synthetic universe

One invented advisory firm, **Cedar Ridge Wealth**, whose households appear across every demo.

- `world.json`: the hand-written parts. The firm, custodians, staff, model portfolios, illustrative prices, and the story households whose records connect the four demos.
- `src/build.ts`: expands that into about 40 households and 100 accounts with a fixed seed. Pure and deterministic.
- `out/universe.json`: the committed output. Each app's seed reads this file.

```bash
npm run generate -w synthetic
npm test -w synthetic
```

Every name, email, phone number and account number is invented. Emails use `example.com`, phones use the reserved `555-01xx` range, and account numbers start with `DEMO-`. Prices are illustrative, not market data.
