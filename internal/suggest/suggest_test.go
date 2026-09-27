package suggest

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestFiles(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  []string
	}{
		{name: "notes.md", files: []string{"Notes.md"}, want: []string{"Notes.md"}},
		{name: "notes.md", files: []string{"notes"}, want: []string{"notes"}},
		{name: "notes.md", files: []string{"notes.txt"}, want: []string{"notes.txt"}},
		{name: "notse.md", files: []string{"notes.md"}, want: []string{"notes.md"}},
		{name: "readme.md", files: []string{"README.md"}, want: []string{"README.md"}},
		{name: "notes.md", files: []string{"todo.md", "main.go"}, want: nil},
		// Short names allow no edits: a.md and b.md are different files.
		{name: "a.md", files: []string{"b.md", "A.md"}, want: []string{"A.md"}},
		// Two edits are too many for a five-letter name, fine for a long one.
		{name: "ntose.md", files: []string{"notes.md"}, want: nil},
		{name: "meeting-nots.md", files: []string{"meeting-notes.md"}, want: []string{"meeting-notes.md"}},
		// Closest first: same extension and case beat a different one.
		{
			name:  "notes.md",
			files: []string{"note.md", "Notes.md", "notes.txt", "notes.md.bak", "nots.md"},
			want:  []string{"Notes.md", "notes.txt", "note.md"},
		},
		// Among other extensions too, the same case comes first.
		{name: "notes.md", files: []string{"Notes.txt", "notes.org"}, want: []string{"notes.org", "Notes.txt"}},
		{name: "notes.md", files: []string{"notes.MD", "notes.txt"}, want: []string{"notes.MD", "notes.txt"}},
		{name: "env", files: []string{".env"}, want: nil},
		{name: ".evn", files: []string{".env"}, want: []string{".env"}},
	}
	for _, tt := range tests {
		dir := t.TempDir()
		for _, f := range tt.files {
			if err := os.WriteFile(filepath.Join(dir, f), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got := Files(dir, tt.name); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Files(%q) with %q = %q, want %q", tt.name, tt.files, got, tt.want)
		}
	}
}

func TestFilesStaysInDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "docs")
	for _, d := range []string{dir, filepath.Join(dir, "notes"), filepath.Join(dir, "sub")} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(root, "notes.md"), filepath.Join(dir, "sub", "notes.md")} {
		if err := os.WriteFile(f, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Neither the parent's file, the subdirectory's, nor the directory named notes.
	if got := Files(dir, "notes.md"); got != nil {
		t.Fatalf("Files = %q", got)
	}
}

func TestFilesFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.md"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.md", filepath.Join(dir, "notes.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing.md", filepath.Join(dir, "Notes.txt")); err != nil {
		t.Fatal(err)
	}
	if got := Files(dir, "notse.md"); !reflect.DeepEqual(got, []string{"notes.md"}) {
		t.Fatalf("Files = %q", got)
	}
}

func TestDistance(t *testing.T) {
	for _, tt := range []struct {
		a, b string
		want int
	}{
		{"notes", "notes", 0},
		{"notse", "notes", 1},
		{"note", "notes", 1},
		{"nites", "notes", 1},
		{"ntose", "notes", 2},
		{"", "abc", 3},
		{"メモ", "メモ帳", 1},
	} {
		if got := distance(tt.a, tt.b); got != tt.want {
			t.Errorf("distance(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
