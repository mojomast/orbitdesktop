# ADR 001: preserve runtime and authority boundaries

Status: accepted for incremental implementation.

Keep Hermes, TypeScript/Vite/Three.js, Node, tmux and immutable app publication.
Separate stable surface/resource identity from layout and grants. Retain legacy
pane IDs in migration; unknown providers remain unavailable descriptors, not deletion.
No v2 write path may coexist with lossy writable v1 snapshot synchronization.

Grants live outside layout undo. A checkpoint does not undo processes, documents,
filesystem effects, conversations or remote actions. Trusted host code and owner
shell access cannot be confined by an iframe broker. Do not give legacy broadly
network-enabled apps private reads implicitly.
