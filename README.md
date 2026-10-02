# webbox

Playground for web apps. Each app lives in its own folder and is published as it is, with no build step,
to GitHub Pages at https://ref12labs.github.io/webbox/ by the workflow in `.github/workflows/pages.yml` on every
push to `main`.

| App | Folder | What it is |
| --- | --- | --- |
| hexad remote | `/hexad/` (source: `web/remote` in Ref12/hexad) | The phone side of hexad's remote access: pairs with a hexad from a QR code, rings it through a Web Push doorbell to open its dev tunnel, shows hexad framed and its notifications, and takes shares. The workflow checks it out from the hexad repository with a read-only deploy key (secret `HEXAD_DEPLOY_KEY`; branch from the repository variable `HEXAD_REF`, default `main`). After a change there, run `gh workflow run pages.yml -R ref12labs/webbox`. |

Line endings are left alone (`.gitattributes` has `* -text`).
