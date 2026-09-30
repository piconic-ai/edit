//go:build windows

package main

import "os"

func canRead(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

// canWrite reports a file with the read-only attribute as not writable.
// Windows ignores that attribute on directories, so they always pass.
func canWrite(path string) bool {
	if st, err := os.Stat(path); err == nil && st.IsDir() {
		return true
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}
