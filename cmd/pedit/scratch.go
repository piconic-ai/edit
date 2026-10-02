package main

import "path/filepath"

// createScratch creates an empty Markdown file without overwriting existing files.
func createScratch(dir string, now func() string) (string, error) {
	path, _, err := prepareFile(config{root: dir, Output: "."}, "", "", "", now)
	if err != nil {
		return "", err
	}
	return filepath.Base(path), nil
}
