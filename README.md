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

Anything promoted by either mechanism is marked with a small history icon, so the
ranking never changes silently.

The app adds no doctype and patches nothing: it subclasses the awesome bar and ships
route scores in the boot payload. Uninstall it and the stock behaviour returns.

### Compatibility

Tested on Frappe v17, Dokos/Dodock v6 and Dodock v5.

### Debugging

To see why results were ordered the way they were, run this in the browser console:

```js
awesomebar_lab.debug();       // on  (persists across reloads)
awesomebar_lab.debug(false);  // off
```

Each search then logs the near-tie band, every candidate's match score and frecency,
and what the remembered-pick memory decided. It is off by default and costs nothing
when off.

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

mit
