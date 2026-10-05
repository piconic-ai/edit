module github.com/piconic-ai/edit

go 1.25.0

// The TypeScript packages live alongside; keep ./... out of node_modules.
ignore (
	./node_modules
	./packages
)

require (
	github.com/coder/websocket v1.8.15
	github.com/fsnotify/fsnotify v1.10.1
	github.com/reearth/ygo v1.50.0
	github.com/sergi/go-diff v1.4.0
	golang.org/x/sys v0.44.0
	golang.org/x/term v0.34.0
	gopkg.in/yaml.v3 v3.0.1
)
