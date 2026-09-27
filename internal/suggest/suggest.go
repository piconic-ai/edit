// Package suggest finds files whose names are close to one that does not
// exist, to turn a typo into a ready-to-run command.
package suggest

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// limit is how many suggestions Files returns at most.
const limit = 3

// Files returns the names of regular files directly in dir that are close to
// name, closest first. Close means the same base name ignoring case and the
// extension, or a few edits away from it (see threshold). Dotfiles are left
// out unless name starts with a dot.
func Files(dir, name string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	stem, ext := split(name)
	type candidate struct {
		name      string
		dist      int
		otherExt  bool
		otherCase bool
	}
	var found []candidate
	max := threshold(stem)
	for _, e := range entries {
		n := e.Name()
		if n == name || (strings.HasPrefix(n, ".") && !strings.HasPrefix(name, ".")) || !isRegular(dir, e) {
			continue
		}
		s, x := split(n)
		d := distance(strings.ToLower(stem), strings.ToLower(s))
		if d > max {
			continue
		}
		found = append(found, candidate{
			name:      n,
			dist:      d,
			otherExt:  !strings.EqualFold(ext, x),
			otherCase: s != stem || (x != ext && strings.EqualFold(x, ext)),
		})
	}
	sort.Slice(found, func(i, j int) bool {
		a, b := found[i], found[j]
		switch {
		case a.dist != b.dist:
			return a.dist < b.dist
		case a.otherExt != b.otherExt:
			return !a.otherExt
		case a.otherCase != b.otherCase:
			return !a.otherCase
		default:
			return a.name < b.name
		}
	})
	var names []string
	for i := 0; i < len(found) && i < limit; i++ {
		names = append(names, found[i].name)
	}
	return names
}

// isRegular follows symlinks, since people share files through them too.
func isRegular(dir string, e os.DirEntry) bool {
	if e.Type()&os.ModeSymlink == 0 {
		return e.Type().IsRegular()
	}
	st, err := os.Stat(filepath.Join(dir, e.Name()))
	return err == nil && st.Mode().IsRegular()
}

// split separates the extension from name. A dotfile such as .env is all
// base name.
func split(name string) (stem, ext string) {
	ext = filepath.Ext(name)
	if ext == name {
		return name, ""
	}
	return strings.TrimSuffix(name, ext), ext
}

// threshold is how many edits a base name of this length may be away from
// another and still count as close: none for short names, where any edit
// makes a different word, then one more for every four characters.
func threshold(stem string) int {
	return min(len([]rune(stem))/4, 3)
}

// distance is the Damerau-Levenshtein distance (optimal string alignment),
// so swapping two neighbouring characters counts as one edit.
func distance(a, b string) int {
	s, t := []rune(a), []rune(b)
	d := make([][]int, len(s)+1)
	for i := range d {
		d[i] = make([]int, len(t)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(s); i++ {
		for j := 1; j <= len(t); j++ {
			cost := 1
			if s[i-1] == t[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && s[i-1] == t[j-2] && s[i-2] == t[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(s)][len(t)]
}
