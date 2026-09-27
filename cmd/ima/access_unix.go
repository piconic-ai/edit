//go:build unix

package main

import "golang.org/x/sys/unix"

func canRead(path string) bool  { return unix.Access(path, unix.R_OK) == nil }
func canWrite(path string) bool { return unix.Access(path, unix.W_OK) == nil }
