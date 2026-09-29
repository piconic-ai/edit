package session

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/piconic-ai/ima/internal/canvas"
	"github.com/piconic-ai/ima/internal/merge"
	"github.com/reearth/ygo/crdt"
)

// content is how the file is shared in the doc: as text, or a JSON Canvas as
// nodes and edges.
type content interface {
	// render returns the file as the doc has it now.
	render() string
	// merge takes in an edit made to the file outside ima, from base (what we
	// last wrote) to next. It fails, changing nothing, when next cannot be
	// taken in.
	merge(base, next string) error
}

// formatCanvas is the host's awareness "format" in a room that shares a
// canvas as nodes and edges; packages/web reads it. Text rooms leave it out.
const formatCanvas = "canvas"

func isCanvas(file string) bool { return strings.EqualFold(filepath.Ext(file), ".canvas") }

type textContent struct {
	doc  *crdt.Doc
	text *crdt.YText
}

func newTextContent(doc *crdt.Doc, initial string) *textContent {
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, initial, nil) })
	return &textContent{doc: doc, text: text}
}

func (c *textContent) render() string { return c.text.ToString() }

func (c *textContent) merge(base, next string) error {
	merge.ExternalEdit(c.doc, c.text, base, next, fileOrigin)
	return nil
}

type canvasContent struct {
	doc  *crdt.Doc
	name string

	mu sync.Mutex
	// last is the file as last read or written: rendering keeps its layout
	// and the text of what did not change.
	last *canvas.File
}

// newCanvasContent loads a canvas into the doc, or explains why the file is
// not one.
func newCanvasContent(doc *crdt.Doc, file, initial string) (*canvasContent, error) {
	name := filepath.Base(file)
	f, err := canvas.Parse([]byte(initial))
	if err != nil {
		return nil, describeCanvasError(name, err)
	}
	canvas.Load(doc, f.Canvas)
	return &canvasContent{doc: doc, name: name, last: f}, nil
}

func describeCanvasError(name string, err error) error {
	if e, ok := err.(*canvas.Error); ok {
		return fmt.Errorf("%s", e.Report(name))
	}
	return err
}

func (c *canvasContent) render() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := canvas.Render(canvas.Read(c.doc), c.last)
	// Read keeps only what a file can hold, so this parses.
	if f, err := canvas.Parse(out); err == nil {
		c.last = f
	}
	return string(out)
}

func (c *canvasContent) merge(base, next string) error {
	b, n, err := c.parsePair(base, next)
	if err != nil {
		return err
	}
	canvas.Apply(c.doc, b.Canvas, n.Canvas, fileOrigin)
	c.mu.Lock()
	c.last = n
	c.mu.Unlock()
	return nil
}

// edit applies JSON someone edited by hand in the browser. Unlike an edit to
// the file, it is not what the file holds, so the file keeps its layout.
func (c *canvasContent) edit(base, next string) error {
	b, n, err := c.parsePair(base, next)
	if err != nil {
		return err
	}
	canvas.Apply(c.doc, b.Canvas, n.Canvas, editOrigin)
	return nil
}

func (c *canvasContent) parsePair(base, next string) (*canvas.File, *canvas.File, error) {
	b, err := canvas.Parse([]byte(base))
	if err != nil {
		return nil, nil, describeCanvasError(c.name, err)
	}
	n, err := canvas.Parse([]byte(next))
	if err != nil {
		return nil, nil, describeCanvasError(c.name, err)
	}
	return b, n, nil
}
