# token-radar-v8

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/naufalumer/token-radar-v8/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/naufalumer/token-radar-v8/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar v8 — a GMGN-style launch terminal for the make.fun token-radar-01 bounty. It reads a sealed DefiLlama snapshot, finds protocols with no token, ranks them by implied launch value, and hands in a web dashboard.

## Run it

```sh
node main.ts --input <snapshot.json> --output out
```

The board (`board.json`), dashboard data (`data.js`) and dossier (`dossier.json`) land in the output dir. The dashboard renders with no network: open `out/dashboard/index.html`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bye4mn13&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
