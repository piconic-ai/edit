import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("update-homebrew-formula.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class FormulaUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.assets = Path(self.temp.name)
        self.formula = 'class Pedit < Formula\n  version "0.1.0-rc.7"\n'
        for target in updater.TARGETS:
            self.formula += f'      sha256 "{"a" * 64}" # {target}\n'
        self.formula += '  def install\n    bin.install "pedit"\n  end\nend\n'

    def release(self, tag):
        manifest = []
        for target in updater.TARGETS:
            name = f'pedit_{tag}_{target.replace("/", "_")}.tar.gz'
            data = name.encode()
            (self.assets / name).write_bytes(data)
            manifest.append(f'{hashlib.sha256(data).hexdigest()}  {name}')
        (self.assets / "checksums.txt").write_text('\n'.join(manifest))

    def test_update_preserves_install_and_retry_is_idempotent(self):
        self.release('v0.1.0')
        result = updater.update(self.formula, 'v0.1.0', self.assets)
        self.assertIn('  version "0.1.0"', result)
        self.assertIn('    bin.install "pedit"', result)
        self.assertNotIn('a' * 64, result)
        self.assertEqual(result, updater.update(result, 'v0.1.0', self.assets))

    def test_delayed_release_does_not_downgrade(self):
        for current, tag in [('0.1.0-rc.10', 'v0.1.0-rc.9'), ('0.1.0', 'v0.1.0-rc.10'), ('1.0.0', 'v0.2.0')]:
            self.release(tag)
            formula = self.formula.replace('0.1.0-rc.7', current)
            self.assertEqual(formula, updater.update(formula, tag, self.assets))

    def test_same_version_rebuilt_archives_update_checksums(self):
        self.release('v0.1.0-rc.7')
        self.assertNotEqual(self.formula, updater.update(self.formula, 'v0.1.0-rc.7', self.assets))

    def test_invalid_tags_and_metadata_fail(self):
        for tag in ['latest', '0.1.0', 'v01.0.0', 'v1.0.0-01', 'v1.0.0"\n']:
            with self.assertRaises(ValueError):
                updater.update(self.formula, tag, self.assets)
        self.release('v0.1.0')
        for formula in [self.formula.replace('Pedit', 'Other'), self.formula + '  version "1.0.0"\n', self.formula.replace('darwin/arm64', 'unknown')]:
            with self.assertRaises(ValueError):
                updater.update(formula, 'v0.1.0', self.assets)

    def test_missing_and_corrupt_archives_fail(self):
        self.release('v0.1.0')
        asset = self.assets / 'pedit_v0.1.0_linux_arm64.tar.gz'
        asset.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            updater.update(self.formula, 'v0.1.0', self.assets)
        asset.unlink()
        with self.assertRaises(FileNotFoundError):
            updater.update(self.formula, 'v0.1.0', self.assets)


if __name__ == '__main__':
    unittest.main()
