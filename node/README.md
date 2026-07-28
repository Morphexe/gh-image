# gh-image Node CLI

A TypeScript/Node.js implementation of `gh-image` for Google Chrome on Linux
and macOS. It supports the same commands as the Go CLI:

```console
gh-image [--repo owner/repo] [--token <value>] <file-path>...
gh-image extract-token
gh-image check-token [--token <value>]
```

## Requirements

- Node.js 22.13 or newer
- GitHub CLI (`gh`), authenticated
- Google Chrome with an active GitHub session, or `GH_SESSION_TOKEN`
- macOS: the built-in `/usr/bin/security` tool
- Linux: `secret-tool` (usually provided by `libsecret-tools`)

The CLI reads Chrome's `user_session` cookie only. On Linux it supports legacy
`v10`, Secret Service `v11`, and Secret Portal `v12` cookie encryption. On
macOS it reads `Chrome Safe Storage` from Keychain.

## Build and run

```bash
npm install
npm run build
node dist/cli.js --help
```

To link the `gh-image` executable locally:

```bash
npm link
gh-image --help
```

Session cookies grant full GitHub account access. Prefer browser extraction for
interactive use and a dedicated bot account when using `GH_SESSION_TOKEN` in CI.
