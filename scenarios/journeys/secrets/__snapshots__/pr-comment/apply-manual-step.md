<!-- sponson:preview -->
### Sponson: the preview for pr-42 waits for a person

This preview has 1 variable.

Still to come: 1 manual step.

**Preview:** [https://prj\_demo-01234567.vercel.app](https://prj_demo-01234567.vercel.app)

- `env` MODE (preview, feat/x), values not shown — set up in this run · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `google-redirect` manual step — waits for a person to do the manual step below

**Manual steps waiting for a person** (no API can do these; a person does them, agents never confirm them)

- `google-redirect` Allow the callback on the Google OAuth client

<pre>1. Open the client "acme-web".
2. Add https://prj_demo-01234567.vercel.app/cb to its authorized redirect URIs and save.</pre>

  Then a person confirms it: `sponson apply --confirm google-redirect`

<sub>apply run-RUNID · plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
