//go:build unix

package filewriter

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPrivateFilePermissions(t *testing.T) {
	const marker = "PEDIT_TEST_FILE_UMASK"
	if value := os.Getenv(marker); value != "" {
		mask, err := strconv.ParseUint(value, 8, 32)
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		preserved := filepath.Join(dir, "existing")
		if err := os.WriteFile(preserved, []byte("old"), 0o640); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(preserved, 0o640); err != nil {
			t.Fatal(err)
		}
		unix.Umask(int(mask))
		fresh := filepath.Join(dir, "new")
		for _, path := range []string{fresh, preserved} {
			if err := WriteAtomic(path, "new"); err != nil {
				t.Fatal(err)
			}
		}
		for path, want := range map[string]os.FileMode{fresh: 0o600 &^ os.FileMode(mask), preserved: 0o640} {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != want {
				t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), want)
			}
		}
		return
	}
	// Umask is process-wide; isolate it from timers and other tests.
	for _, mask := range []int{0, 0o022, 0o077, 0o777} {
		t.Run(fmt.Sprintf("umask=%03o", mask), func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestPrivateFilePermissions$")
			cmd.Env = append(os.Environ(), fmt.Sprintf("%s=%03o", marker, mask))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
		})
	}
}
