package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// createScratch creates an empty Markdown file in dir for `pedit` run without a
// file. The name carries the time so scratch files sort and do not collide;
// if one exists anyway, a counter is added. It never overwrites a file.
func createScratch(dir string, now func() string) (string, error) {
	base := "pedit-" + now()
	for n := 1; ; n++ {
		name := base + ".md"
		if n > 1 {
			name = fmt.Sprintf("%s-%d.md", base, n)
		}
		f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		return name, f.Close()
	}
}
