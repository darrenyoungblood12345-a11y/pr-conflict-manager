# Landing page and downloadable agent skill

The public page is deployed from this repository to
<https://darrenyoungblood12345-a11y.github.io/pr-conflict-manager/>.
Source lives in `site/`; prepared output is ignored under `.local/site-dist/`.
The Electron application's `dist/` is separate.

## Update the downloads

1. Run `npm run check`, then `npm run dist:mac` on an Apple Silicon Mac. Inspect
   the resulting development DMG, checksum, and `.dmg.json` report in `release/`.
2. Update `site/release.json` with the app version, exact release tag, asset name,
   DMG byte size, and SHA-256 from that verified artifact. The build rejects
   metadata that disagrees with `package.json` or the expected artifact name.
3. Create a draft GitHub Release for that tag, attach the `.dmg`, `.dmg.sha256`,
   and `.dmg.json` files, and publish it when the assets are complete. The current
   release is a development prerelease; its exact tag is used in the page links.
4. Publish through `.github/workflows/pages.yml`. Release publication, later
   relevant pushes to `main`, or a manual workflow dispatch deploy the page.
   The first push into an empty repository waits for release publication.

The workflow uses Node and the runner's ZIP utility without installing the
Electron app's dependencies. Before deployment it checks the remote DMG size,
the checksum file, and the matching mounted-app inspection report. Missing or
inconsistent assets fail the build before a page is published.

To prepare production output locally:

```sh
npm run site:verify-release
```

For a local preview that serves the actual installer from disk:

```sh
npm run site:build:local
python3 -m http.server 4173 --bind 127.0.0.1 --directory .local/site-preview
```

Visit `http://127.0.0.1:4173`. The local build checks the DMG hash, report, and
checksum before copying the downloads. Only the production site output is
deployed; the large installer remains a GitHub Release asset.

## Agent skill

The canonical instructions are `skills/agent-pr-monitor/SKILL.md`. Site
preparation generates `downloads/SKILL.md` and `downloads/agent-pr-monitor-skill.zip`
from that file. The ZIP contains only `agent-pr-monitor/SKILL.md`; it contains no
session contexts, endpoint credentials, receipts, generated config, or local paths.

Unzip the folder into a client's supported skills directory, or supply its
Markdown as project instructions. Then use the app's **Agents** screen to prepare
and review the integration for each actual native client session. The skill
does not install MCP, enable hooks, or grant editing permission on its own.

Keep its tool reference and lifecycle instructions aligned with
`src/integrations/mcp.ts`, `schemas.ts`, and `docs/task-pull-requests.md`. Validate
its YAML/frontmatter with the skill-creator validator when that tool is available.
The app's existing protocol tests verify the real interface, while commercial
client enforcement remains a distinct qualification step.

The product image is a CUA capture of the actual built renderer backed by an
isolated coordinator with fictional demonstration tasks. It is labelled as a
demo on the page and contains no personal workspace state.
