package canvas

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Spec is where the format is described, for people and agents fixing a file.
const Spec = "https://jsoncanvas.org/spec/1.0/"

// maxProblems caps how many problems an Error lists.
const maxProblems = 20

// Problem is one thing wrong with a canvas file.
type Problem struct {
	// 1-based line and column (in characters) of what is wrong.
	Line, Column int
	// Where in the canvas, as a JSON path such as nodes[3].width; empty for the file as a whole.
	Path    string
	Message string
}

// Error lists what makes a file not valid JSON Canvas.
type Error struct {
	Problems []Problem
	// How many problems were found beyond those listed.
	More int
}

func (e *Error) Error() string { return e.Report("") }

// Report explains the problems for someone, or a coding agent, to fix the
// file: one "file:line:column: path: message" line each, which editors and
// agents can jump to, then what to do.
func (e *Error) Report(name string) string {
	if name == "" {
		name = "the file"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s is not a valid JSON Canvas (%s):\n", name, Spec)
	for _, p := range e.Problems {
		fmt.Fprintf(&b, "  %s:%d:%d: ", name, p.Line, p.Column)
		if p.Path != "" {
			b.WriteString(p.Path + ": ")
		}
		b.WriteString(p.Message + "\n")
	}
	if e.More > 0 {
		fmt.Fprintf(&b, "  and %d more\n", e.More)
	}
	b.WriteString("Fix the file and run ima again.")
	return b.String()
}

var (
	nodeTypes        = []string{"text", "file", "link", "group"}
	sides            = []string{"top", "right", "bottom", "left"}
	ends             = []string{"none", "arrow"}
	backgroundStyles = []string{"cover", "ratio", "repeat"}
)

type validator struct {
	text     string
	problems []Problem
	more     int
}

func (v *validator) report(offset int, path, format string, args ...any) {
	if len(v.problems) >= maxProblems {
		v.more++
		return
	}
	line, col := position(v.text, offset)
	v.problems = append(v.problems, Problem{Line: line, Column: col, Path: path, Message: fmt.Sprintf(format, args...)})
}

// describe names a JSON value's type for messages.
func describe(n *jnode) string {
	switch n.kind {
	case kindObject:
		return "an object"
	case kindArray:
		return "a list"
	}
	switch n.value.(type) {
	case string:
		return "a string"
	case bool:
		return "true or false"
	case nil:
		return "null"
	}
	return "a number"
}

// object checks n is an object with each key once, and returns its fields by key.
func (v *validator) object(n *jnode, path string) (map[string]jfield, bool) {
	if n.kind != kindObject {
		v.report(n.start, path, "must be an object, not %s", describe(n))
		return nil, false
	}
	fields := make(map[string]jfield, len(n.fields))
	for _, f := range n.fields {
		if _, dup := fields[f.key]; dup {
			v.report(f.keyStart, path, "%q appears more than once; keep one", f.key)
		}
		fields[f.key] = f
	}
	return fields, true
}

func (v *validator) file(root *jnode) *File {
	fields, ok := v.object(root, "")
	if !ok {
		return nil
	}
	f := &File{extra: map[string]string{}, Canvas: Canvas{Extra: map[string]any{}}}
	for _, fl := range root.fields {
		f.keys = append(f.keys, fl.key)
		if fl.key != "nodes" && fl.key != "edges" {
			f.extra[fl.key] = fl.val.raw(v.text)
			f.Canvas.Extra[fl.key] = fl.val.decode()
		}
	}
	nodeIDs := map[string]bool{}
	f.nodes = v.list(fields, "nodes", func(n *jnode, path string) (item, bool) {
		return v.node(n, path, nodeIDs)
	})
	edgeIDs := map[string]bool{}
	f.edges = v.list(fields, "edges", func(n *jnode, path string) (item, bool) {
		return v.edge(n, path, edgeIDs, nodeIDs)
	})
	for _, it := range f.nodes {
		f.Canvas.Nodes = append(f.Canvas.Nodes, it.values)
	}
	for _, it := range f.edges {
		f.Canvas.Edges = append(f.Canvas.Edges, it.values)
	}
	return f
}

func (v *validator) list(fields map[string]jfield, key string, check func(*jnode, string) (item, bool)) []item {
	fl, ok := fields[key]
	if !ok {
		return nil
	}
	if fl.val.kind != kindArray {
		v.report(fl.val.start, key, "must be a list, not %s", describe(fl.val))
		return nil
	}
	var items []item
	for i, n := range fl.val.items {
		if it, ok := check(n, fmt.Sprintf("%s[%d]", key, i)); ok {
			items = append(items, it)
		}
	}
	return items
}

// item reads a node's or edge's fields in order, with their text.
func (v *validator) item(n *jnode) item {
	it := item{raw: n.raw(v.text), raws: map[string]string{}, values: map[string]any{}}
	for _, f := range n.fields {
		if _, seen := it.raws[f.key]; !seen {
			it.keys = append(it.keys, f.key)
		}
		it.raws[f.key] = f.val.raw(v.text)
		it.values[f.key] = f.val.decode()
	}
	return it
}

// itemPath names an item for messages, with its id when it has one.
func itemPath(path string, n *jnode) string {
	for _, f := range n.fields {
		if s, ok := f.val.value.(string); ok && f.key == "id" && s != "" {
			return fmt.Sprintf("%s (id %q)", path, s)
		}
	}
	return path
}

// id checks the required, unique id.
func (v *validator) id(n *jnode, fields map[string]jfield, path string, seen map[string]bool) (string, bool) {
	f, ok := fields["id"]
	if !ok {
		v.report(n.start, path, `has no "id"; add a unique string id`)
		return "", false
	}
	id, ok := f.val.value.(string)
	if !ok || f.val.kind != kindScalar || id == "" {
		v.report(f.val.start, path, `"id" must be a non-empty string, not %s`, describe(f.val))
		return "", false
	}
	if seen[id] {
		v.report(f.val.start, path, "id %q is used more than once; ids must be unique", id)
		return "", false
	}
	seen[id] = true
	return id, true
}

// str checks an optional (or, with required, a required) string field, and returns it.
func (v *validator) str(n *jnode, fields map[string]jfield, path, key string, required bool, allowed []string) (string, bool) {
	f, ok := fields[key]
	if !ok {
		if required {
			v.report(n.start, path, "has no %q; add it as a string", key)
			return "", false
		}
		return "", true
	}
	s, isString := f.val.value.(string)
	if f.val.kind != kindScalar || !isString {
		v.report(f.val.start, path, "%q must be a string, not %s", key, describe(f.val))
		return "", false
	}
	if allowed != nil && !slices.Contains(allowed, s) {
		v.report(f.val.start, path, "%q is %q; it must be one of %s", key, s, quoteAll(allowed))
		return "", false
	}
	return s, true
}

func quoteAll(values []string) string {
	q := make([]string, len(values))
	for i, s := range values {
		q[i] = fmt.Sprintf("%q", s)
	}
	return strings.Join(q, ", ")
}

func (v *validator) node(n *jnode, path string, ids map[string]bool) (item, bool) {
	path = itemPath(path, n)
	fields, ok := v.object(n, path)
	if !ok {
		return item{}, false
	}
	before := len(v.problems) + v.more
	id, _ := v.id(n, fields, path, ids)
	typ, _ := v.str(n, fields, path, "type", true, nil)
	for _, key := range []string{"x", "y", "width", "height"} {
		f, ok := fields[key]
		if !ok {
			v.report(n.start, path, "has no %q; add it as a number", key)
			continue
		}
		if _, isNum := f.val.value.(json.Number); !isNum || f.val.kind != kindScalar {
			v.report(f.val.start, path, "%q must be a number, not %s", key, describe(f.val))
		}
	}
	// Types the spec does not define are kept and drawn as a plain box.
	switch typ {
	case "text":
		v.str(n, fields, path, "text", true, nil)
	case "file":
		v.str(n, fields, path, "file", true, nil)
		v.str(n, fields, path, "subpath", false, nil)
	case "link":
		v.str(n, fields, path, "url", true, nil)
	case "group":
		v.str(n, fields, path, "label", false, nil)
		v.str(n, fields, path, "background", false, nil)
		v.str(n, fields, path, "backgroundStyle", false, backgroundStyles)
	}
	v.str(n, fields, path, "color", false, nil)
	if len(v.problems)+v.more > before {
		return item{}, false
	}
	it := v.item(n)
	it.id = id
	return it, true
}

func (v *validator) edge(n *jnode, path string, ids, nodes map[string]bool) (item, bool) {
	path = itemPath(path, n)
	fields, ok := v.object(n, path)
	if !ok {
		return item{}, false
	}
	before := len(v.problems) + v.more
	id, _ := v.id(n, fields, path, ids)
	for _, key := range []string{"fromNode", "toNode"} {
		if s, ok := v.str(n, fields, path, key, true, nil); ok && !nodes[s] {
			v.report(fields[key].val.start, path, "%q is %q, which is not the id of any node", key, s)
		}
	}
	v.str(n, fields, path, "fromSide", false, sides)
	v.str(n, fields, path, "toSide", false, sides)
	v.str(n, fields, path, "fromEnd", false, ends)
	v.str(n, fields, path, "toEnd", false, ends)
	v.str(n, fields, path, "color", false, nil)
	v.str(n, fields, path, "label", false, nil)
	if len(v.problems)+v.more > before {
		return item{}, false
	}
	it := v.item(n)
	it.id = id
	return it, true
}
