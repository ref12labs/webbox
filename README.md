# webbox

Playground for web apps. Each app lives in its own folder and is published as it is, with no build step,
to GitHub Pages at https://ref12labs.github.io/webbox/ by the workflow in `.github/workflows/pages.yml` on every
push to `main`.

| App | Folder | What it is |
| --- | --- | --- |
| hexad remote | `hexad/` | The phone side of hexad's remote access: pairs with a hexad from a QR code, rings it through a Web Push doorbell to open its dev tunnel, and shows its notifications. |

Line endings are left alone (`.gitattributes` has `* -text`).
