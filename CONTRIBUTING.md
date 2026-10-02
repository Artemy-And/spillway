# Contributing to Spillway

Thanks for helping. Questions, bug reports, translations and code are all welcome.

## Where things go

- **Questions and setup help** — [Discussions](https://github.com/Artemy-And/spillway/discussions)
- **Bugs and clear feature requests** — [Issues](https://github.com/Artemy-And/spillway/issues)
- **Security problems** — privately, see [SECURITY.md](SECURITY.md)

## Making a change

1. For anything larger than a small fix, open an issue or a discussion first so we agree on the
   approach before you spend time on it.
2. Branch from `develop` and open the pull request against `develop`. `main` only moves on releases.
3. Keep pull requests focused: one change, with a clear description of what and why.
4. Before pushing, run:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

5. Write commit messages in English, in the imperative: "Add German translation", not "Added".

See [Development](README.md#development) in the README for the setup.

## Contributor License Agreement

On your first pull request a bot asks you to sign the [Contributor License Agreement](CLA.md) by
posting a comment. You keep the copyright to your work. The agreement lets Spillway stay under
AGPL-3.0 and also be offered under other terms later, for example to a company that cannot use
AGPL software.

## Translations

Interface strings live in `apps/web/src/i18n/`. `en.ts` is the source; every other language must
match its shape or the build fails.
