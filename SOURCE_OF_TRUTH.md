# Source-of-Truth Contract

Project Observatory is the canonical, versioned knowledge source of truth for
the interpreted current state, architecture, decisions, history, and observed
production state of a registered project.

It does not replace source systems. Git is authoritative for code and commits;
deployment providers are authoritative for deployments; operational systems are
authoritative for their own raw records. Observatory stores their evidence,
resolves it into knowledge, retains the provenance, and snapshots its
interpretation over time.

```text
Evidence (read-only sources) → Resolved knowledge → Immutable history
```

Every resolved assertion is evidence-backed or explicitly labelled
`operator_asserted`. Contradictory evidence is retained and surfaced as a
conflict; it is never silently overwritten. AI responses should identify the
snapshot and resolution status that they use.
