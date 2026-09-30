package canvas

import (
	"sort"

	"github.com/piconic-ai/edit/internal/merge"
	"github.com/reearth/ygo/crdt"
)

// Apply makes in a document the change from base to next: an edit made to the
// file outside pedit, or JSON someone edited by hand in the browser. The
// document may have moved on from base meanwhile, and what others changed
// there is kept unless the change touches the same field. Nodes and edges are
// matched by id; a text node's text merges by character.
//
// The caller must keep the document from changing concurrently, and must not
// call Apply from inside a transaction.
func Apply(doc *crdt.Doc, base, next Canvas, origin any) {
	var texts []textEdit
	texts = append(texts, applyList(doc, doc.GetArray(NodesKey), base.Nodes, next.Nodes, origin)...)
	texts = append(texts, applyList(doc, doc.GetArray(EdgesKey), base.Edges, next.Edges, origin)...)

	extra := doc.GetMap(ExtraKey)
	if keys := changedKeys(base.Extra, next.Extra); len(keys) > 0 {
		doc.Transact(func(txn *crdt.Transaction) {
			for _, k := range keys {
				if v, ok := next.Extra[k]; ok {
					extra.Set(txn, k, v)
				} else {
					extra.Delete(txn, k)
				}
			}
		}, origin)
	}

	for _, t := range texts {
		merge.ExternalEdit(doc, t.text, t.base, t.next, origin)
	}
}

// textEdit is a change to a text node's text, merged by character once the
// structure is in place.
type textEdit struct {
	text       *crdt.YText
	base, next string
}

// changedKeys returns the keys whose value differs between a and b, sorted.
func changedKeys(a, b map[string]any) []string {
	var keys []string
	for k, v := range a {
		if w, ok := b[k]; !ok || !equal(v, w) {
			keys = append(keys, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func idOf(values map[string]any) string {
	id, _ := values["id"].(string)
	return id
}

// entry is one item of a list in the document.
type entry struct {
	id string
	m  *crdt.YMap
	// Its values, and its text as a Y.Text when it has one.
	now  map[string]any
	text *crdt.YText
}

// readEntries reads a list. Reads take the document lock, which a
// transaction holds, so lists are read before one starts.
func readEntries(list *crdt.YArray) []entry {
	var out []entry
	for i := 0; i < list.Len(); i++ {
		e := entry{}
		if m, ok := list.Get(i).(*crdt.YMap); ok {
			e.m = m
			e.now = map[string]any{}
			for _, k := range m.Keys() {
				v, _ := m.Get(k)
				if t, ok := v.(*crdt.YText); ok && k == TextKey {
					e.text = t
				}
				e.now[k] = plain(v)
			}
			e.id = idOf(e.now)
		}
		out = append(out, e)
	}
	return out
}

func indexOf(entries []entry, id string) int {
	for i, e := range entries {
		if e.id == id && id != "" {
			return i
		}
	}
	return -1
}

func applyList(doc *crdt.Doc, list *crdt.YArray, base, next []map[string]any, origin any) []textEdit {
	baseByID := map[string]map[string]any{}
	for _, v := range base {
		baseByID[idOf(v)] = v
	}
	nextByID := map[string]map[string]any{}
	for _, v := range next {
		nextByID[idOf(v)] = v
	}
	current := readEntries(list)
	nowByID := map[string]entry{}
	for _, e := range current {
		if _, dup := nowByID[e.id]; !dup && e.id != "" {
			nowByID[e.id] = e
		}
	}
	moved := movedIDs(base, next)

	var texts []textEdit
	// A text edit on a field set in the same transaction waits for it to end.
	merges := func(t *crdt.YText, b, n string) {
		if b != n {
			texts = append(texts, textEdit{t, b, n})
		}
	}
	doc.Transact(func(txn *crdt.Transaction) {
		// Remove what next removed, and what it moved, which goes back in its new place.
		for i := len(current) - 1; i >= 0; i-- {
			id := current[i].id
			_, inBase := baseByID[id]
			_, inNext := nextByID[id]
			if id != "" && ((inBase && !inNext) || moved[id]) {
				list.Delete(txn, i, 1)
				current = append(current[:i], current[i+1:]...)
			}
		}

		// Put back what next added or moved.
		for i, v := range next {
			id := idOf(v)
			if indexOf(current, id) >= 0 {
				continue
			}
			b, inBase := baseByID[id]
			now, inDoc := nowByID[id]
			values := v
			mergeText := false
			if inBase {
				if !inDoc {
					// Someone else deleted it meanwhile: that deletion stands.
					continue
				}
				// A moved item keeps what others changed meanwhile, with next's changes on top.
				values, mergeText = overlay(now.now, b, v)
			}
			// Before the item after it in next, or on top: a node brought to the
			// front stays in front of what others added meanwhile.
			at := len(current)
			for _, after := range next[i+1:] {
				if k := indexOf(current, idOf(after)); k >= 0 {
					at = k
					break
				}
			}
			m, text := newItem(txn, values)
			list.InsertType(txn, at, m)
			current = append(current[:at], append([]entry{{id: id, m: m}}, current[at:]...)...)
			if mergeText && text != nil {
				bs, _ := b[TextKey].(string)
				ns, _ := v[TextKey].(string)
				merges(text, bs, ns)
			}
		}

		// Change the fields next changed, in the items that stayed where they were.
		for _, e := range current {
			b, inBase := baseByID[e.id]
			n, inNext := nextByID[e.id]
			now, inDoc := nowByID[e.id]
			if !inBase || !inNext || !inDoc || moved[e.id] || now.m != e.m {
				continue
			}
			for _, k := range changedKeys(b, n) {
				nv, keep := n[k]
				if !keep {
					e.m.Delete(txn, k)
					continue
				}
				bs, wasString := b[k].(string)
				ns, isString := nv.(string)
				if k == TextKey && isString {
					if wasString && now.text != nil {
						merges(now.text, bs, ns)
						continue
					}
					t := crdt.NewTextPrelim()
					t.Insert(txn, 0, ns, nil)
					e.m.Set(txn, k, t)
					continue
				}
				e.m.Set(txn, k, nv)
			}
		}
	}, origin)
	return texts
}

// overlay returns now with the change from base to next on top. A text that
// next changes and now still has is left as it is now, and mergeText says it
// is to merge by character afterwards; a text only next has is taken as it
// is, and one next removed is removed.
func overlay(now, base, next map[string]any) (out map[string]any, mergeText bool) {
	out = make(map[string]any, len(now))
	for k, v := range now {
		out[k] = v
	}
	for _, k := range changedKeys(base, next) {
		_, inNow := out[k]
		_, inNext := next[k]
		if k == TextKey && inNow && inNext {
			mergeText = true
			continue
		}
		if v, ok := next[k]; ok {
			out[k] = v
		} else {
			delete(out, k)
		}
	}
	return out, mergeText
}

// movedIDs returns the items next put in a different order than base. Those
// in a longest run kept in order stay where they are; the rest move, so a
// node brought to the front moves alone.
func movedIDs(base, next []map[string]any) map[string]bool {
	baseIndex := map[string]int{}
	for i, v := range base {
		baseIndex[idOf(v)] = i
	}
	var ids []string
	var seq []int
	for _, v := range next {
		if i, ok := baseIndex[idOf(v)]; ok {
			ids = append(ids, idOf(v))
			seq = append(seq, i)
		}
	}
	keep := longestIncreasing(seq)
	moved := map[string]bool{}
	for i, id := range ids {
		if !keep[i] {
			moved[id] = true
		}
	}
	return moved
}

// longestIncreasing marks the positions of a longest increasing subsequence.
func longestIncreasing(seq []int) map[int]bool {
	// tails[k] is the index in seq ending the best run of length k+1.
	var tails []int
	prev := make([]int, len(seq))
	for i, v := range seq {
		k := sort.Search(len(tails), func(k int) bool { return seq[tails[k]] >= v })
		prev[i] = -1
		if k > 0 {
			prev[i] = tails[k-1]
		}
		if k == len(tails) {
			tails = append(tails, i)
		} else {
			tails[k] = i
		}
	}
	keep := map[int]bool{}
	if len(tails) > 0 {
		for i := tails[len(tails)-1]; i >= 0; i = prev[i] {
			keep[i] = true
		}
	}
	return keep
}
