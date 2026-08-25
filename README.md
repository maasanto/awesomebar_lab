### Awesomebar Lab

Frecency ranking and remembered picks for the Frappe and Dokos awesome bar (⌘K / Ctrl+K).

Two changes to how results are ordered, both driven by your own history:

- **Frecency ranking** — among results that already match about equally well, the pages
  you actually open win. A visit is worth full weight the day it happens and half that
  every 14 days, so a page you used daily this week beats one you used twice as often
  but abandoned a month ago. It only ever breaks near-ties: a better match is never
  pushed below a worse one.
- **Remembered picks** — pick Sales Invoice once for "inv" and it is pinned for "inv"
  next time. Remembered per query rather than per result, stored on the device, and
  faded out again if you stop using it.

Anything promoted is marked, so the ranking never changes silently: a pin for a
remembered pick, a clock for a frecency boost.

![Typing "ema" puts the most visited match first with a clock beside it; after Email
Account List is picked once for that query, typing "ema" again pins it to the top with a
pin beside it](docs/demo.gif)

The app patches nothing: it subclasses the awesome bar and ships route scores in the
boot payload. Uninstall it and the stock behaviour returns.

### Tuning

While the ranking is being worked out, the numbers behind it live in **Awesomebar Lab
Settings** (⌘K → "Awesomebar Lab Settings") rather than in the source:

| Setting | Default | What it does |
| --- | --- | --- |
| Near-Tie Band | 0.85 | How close to the best match a result must score to be reordered by history. Lower reorders more of the list. |
| Visit Half Life (Days) | 14 | How fast a past visit loses weight. Shorter favours this week, longer favours all-time. |
| Routes Sent At Boot | 30 | How many of your top routes ship with boot; the rest rank as never visited. |
| Minimum Confidence | 0.65 | How sure a remembered pick must be before it is pinned. Raise it to demand a repeated habit. |
| Memory Half Life (Days) | 14 | How fast a remembered pick fades once you stop using the query. |

Reload the desk after saving — the values ride along with boot. Clearing a field falls
back to its default. This doctype is a development aid and will not ship with the
finished feature.

### Compatibility

Tested on Frappe v17, Dokos/Dodock v6 and Dodock v5.

### Debugging

To see why results were ordered the way they were, run this in the browser console:

```js
awesomebar_lab.debug();       // on  (persists across reloads)
awesomebar_lab.debug(false);  // off
```

Each search then logs the near-tie band, every candidate's match score and frecency,
and what the remembered-pick memory decided. The table is printed once the ranking is
settled and in final rank order, so it reads top to bottom like the dropdown itself.
It is off by default and costs nothing when off.

The ranking pipeline has a check of its own, which needs nothing but node:

```bash
node awesomebar_lab/tests/test_ranking.js
```

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch main
bench install-app awesomebar_lab
```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/awesomebar_lab
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

agpl-3.0
