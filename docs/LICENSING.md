# Licensing & assets

Life Engine is released under the **MIT License** (full text in [`LICENSE`](../LICENSE)). You may use, modify, redistribute and sell copies, including commercially, as long as you keep the copyright and license notice in copies. MIT includes no explicit patent grant.

## Dependencies

Runtime and dev dependencies are kept minimal:

| Package | Role | License |
|---|---|---|
| `cos-nodejs-sdk-v5` | Tencent COS storage client | ISC |
| `vitest` | Test runner | MIT |
| `esbuild` | Bundler for deployment packages | MIT |

Each third-party dependency remains under its own license. Run `npm ls --all` or inspect `package-lock.json` for the full transitive set. `npm audit` may report advisories in transitive dependencies; evaluate and address them before you rely on a deployment.

## Characters & images

| Asset | Status |
|---|---|
| Bundled default character | Fictional, illustrative sample so the engine can start with no pack bound. Not a real person or brand. |
| Example pack `examples/harbor-fox.json` | Fictional demo, `assets: []`, meant to be replaced wholesale. |
| Your own reference images | Used only when you place the files locally and declare their SHA-256 / MIME in a pack manifest. |

The engine reads reference images strictly from the manifest a character pack declares. An empty manifest yields an empty gallery — it never falls back to some other character's images. Any generated or reference imagery you add is yours to license and distribute responsibly.

## Notes

- This is not a full `git-secrets` / `trufflehog` history audit; do your own review before publishing forks or derivatives.
- The project is MIT licensed; third-party dependencies keep their own terms.
