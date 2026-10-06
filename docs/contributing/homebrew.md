# Homebrew releases

After `release-cli` publishes the binaries, `homebrew-formula` opens an update
PR in [piconic-ai/homebrew-tap](https://github.com/piconic-ai/homebrew-tap).
It updates the Formula version and four archive SHA-256 values, calculating
checksums from the downloaded release assets and verifying `checksums.txt`.
Older releases are skipped; unchanged releases create no PR. Retries update
an existing open PR for the same tag. Tap PRs are merged manually.

Merge the initial tap Formula PR before the first automated update.

Set the `HOMEBREW_TAP_TOKEN` Actions secret in **piconic-ai/pedit** to a
fine-grained personal access token for **piconic-ai/homebrew-tap** with
**Contents: Read and write** and **Pull requests: Read and write** permissions.
Approve the token if required by the organization. `GITHUB_TOKEN` cannot write
to the separate tap repository. A missing secret fails the Homebrew job with
a setup message; published binaries remain available.

To retry without rebuilding, manually run `homebrew-formula` on `main` with
the published release tag as its `tag` input. This also supports prereleases.

Run updater regression tests with:

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
```
